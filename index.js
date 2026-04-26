// 小紅書影片 / 圖集下載擴展
// 使用 Gopeed webview API 載入頁面，從 window.__INITIAL_STATE__ 提取媒體資訊

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 將標題中不合法的檔名字元替換掉
function sanitizeFilename(name) {
  return (name || "xhs_media")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 100);
}

// 在 webview 頁面內執行，等待 __INITIAL_STATE__ 並提取媒體資訊
function extractMediaFromPage(preferFormat) {
  return new Promise(function (resolve) {
    var MAX_WAIT_MS = 20000;
    var INTERVAL_MS = 400;
    var elapsed = 0;

    function attempt() {
      elapsed += INTERVAL_MS;
      var state = window.__INITIAL_STATE__;
      var noteMap = state && state.note && state.note.noteDetailMap;

      if (!noteMap && elapsed < MAX_WAIT_MS) {
        setTimeout(attempt, INTERVAL_MS);
        return;
      }

      if (!noteMap) {
        resolve({ error: "載入逾時，無法取得筆記資料。請確認已登入小紅書，或關閉無頭模式重新嘗試。" });
        return;
      }

      var noteIds = Object.keys(noteMap);
      if (noteIds.length === 0) {
        resolve({ error: "找不到筆記 ID，頁面結構可能已變更。" });
        return;
      }

      var noteId = noteIds[0];
      var noteData = noteMap[noteId] && noteMap[noteId].note;
      if (!noteData) {
        resolve({ error: "無法解析筆記內容（noteData 為空）。" });
        return;
      }

      var rawTitle = noteData.title || noteData.desc || noteId;
      var title = rawTitle.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().substring(0, 100);

      // ── 影片筆記 ──
      var isVideo = noteData.type === "video" || !!noteData.video;
      if (isVideo && noteData.video) {
        var video = noteData.video;
        var formats = preferFormat === "h265"
          ? ["h265", "h264", "av1"]
          : ["h264", "h265", "av1"];

        // 嘗試從 media.stream 取得最高畫質
        var streams = video.media && video.media.stream;
        if (streams) {
          for (var fi = 0; fi < formats.length; fi++) {
            var fmt = formats[fi];
            var fmtList = streams[fmt];
            if (Array.isArray(fmtList) && fmtList.length > 0) {
              var sorted = fmtList.slice().sort(function (a, b) {
                return ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0));
              });
              var best = sorted[0];
              var url = best.masterUrl || (best.backupUrls && best.backupUrls[0]);
              if (url) {
                resolve({
                  type: "video",
                  title: title,
                  url: url,
                  format: fmt,
                  width: best.width,
                  height: best.height,
                });
                return;
              }
            }
          }
        }

        // Fallback：consumer.originVideoKey（通常是 CDN key，不是完整 URL，但先試試）
        var consumerUrl = video.consumer && video.consumer.originVideoKey;
        if (consumerUrl && consumerUrl.startsWith("http")) {
          resolve({ type: "video", title: title, url: consumerUrl });
          return;
        }

        resolve({ error: "找到影片筆記，但無法取得可下載的串流網址。頁面結構可能已變更。" });
        return;
      }

      // ── 圖集筆記 ──
      var imageList = noteData.imageList;
      if (Array.isArray(imageList) && imageList.length > 0) {
        var images = [];
        for (var i = 0; i < imageList.length; i++) {
          var img = imageList[i];
          // 優先取無浮水印的原圖，依序 fallback
          var imgUrl =
            (img.infoList && img.infoList[0] && img.infoList[0].url) ||
            img.urlDefault ||
            img.url;
          if (imgUrl) {
            var pad = String(i + 1).padStart(2, "0");
            images.push({ name: title + "_" + pad + ".jpg", url: imgUrl });
          }
        }
        if (images.length > 0) {
          resolve({ type: "images", title: title, images: images });
          return;
        }
      }

      resolve({ error: "此筆記沒有影片也沒有圖片，或頁面結構已變更。" });
    }

    setTimeout(attempt, INTERVAL_MS);
  });
}

gopeed.events.onResolve(async function (ctx) {
  // 檢查 webview 是否可用（需要 Gopeed 桌面版）
  if (!gopeed.runtime.webview || !gopeed.runtime.webview.isAvailable()) {
    throw new MessageError(
      "此擴展需要 Gopeed 桌面版（webview 功能不可用）。請下載桌面版後重試。"
    );
  }

  var isHeadless = gopeed.settings.headless === true;
  var preferFormat = gopeed.settings.prefer_format || "h264";

  gopeed.logger.info("[XHS] 開啟 webview，headless=" + isHeadless + "，preferFormat=" + preferFormat);

  var page = await gopeed.runtime.webview.open({
    headless: isHeadless,
    title: "小紅書影片下載器",
    width: 1280,
    height: 800,
  });

  try {
    await page.goto(ctx.req.url, {
      waitUntil: "domcontentloaded",
      timeoutMs: 30000,
    });

    gopeed.logger.info("[XHS] 頁面已載入，開始提取媒體資訊…");

    // 將 extractMediaFromPage 序列化後傳入 webview 執行
    var result = await page.execute(
      new Function(
        "preferFormat",
        "return (" + extractMediaFromPage.toString() + ")(preferFormat);"
      ),
      preferFormat
    );

    gopeed.logger.info("[XHS] 提取結果：" + JSON.stringify(result));

    if (!result || result.error) {
      throw new MessageError(
        (result && result.error) || "未知錯誤，無法提取媒體資訊。"
      );
    }

    var commonHeaders = {
      Referer: "https://www.xiaohongshu.com/",
      "User-Agent": DEFAULT_UA,
    };

    if (result.type === "video") {
      var ext = result.url && result.url.indexOf(".mp4") !== -1 ? ".mp4" : ".mp4";
      ctx.res = {
        name: sanitizeFilename(result.title),
        files: [
          {
            name: sanitizeFilename(result.title) + ext,
            req: {
              url: result.url,
              headers: commonHeaders,
            },
          },
        ],
      };
      gopeed.logger.info(
        "[XHS] 影片任務建立成功，格式=" + result.format +
        "，解析度=" + result.width + "x" + result.height
      );
    } else if (result.type === "images") {
      ctx.res = {
        name: sanitizeFilename(result.title),
        files: result.images.map(function (img) {
          return {
            name: sanitizeFilename(img.name),
            req: {
              url: img.url,
              headers: commonHeaders,
            },
          };
        }),
      };
      gopeed.logger.info("[XHS] 圖集任務建立成功，共 " + result.images.length + " 張");
    }
  } finally {
    await page.close();
  }
});
