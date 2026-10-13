package io.github.lamposian.tof;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.Manifest;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.content.SharedPreferences;
import android.provider.ContactsContract;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Hosts the Tof web app and feeds it TextNow exports shared from other apps. */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/index.html";
    private static final int PICK_FILES = 1;
    private static final int ASK_CONTACTS = 2;
    private static final int PICK_LOG_FOLDER = 3;
    private static final int PICK_MEDIA_FOLDER = 4;
    private static final int SAVE_MEDIA_AS = 5;
    private static final int ASK_NOTIFY = 6;
    private static final String LOG_NAME = "tof-log.txt";
    private static final int MAX_BYTES = 20 * 1024 * 1024;
    private static final long MAX_MEDIA_BYTES = 300L * 1024 * 1024;

    private WebView web;
    private WebViewAssetLoader assets;
    private ValueCallback<Uri[]> pendingChooser;
    private final List<Uri> pendingShares = new ArrayList<>();
    private String pendingText;
    private boolean pageReady;
    private File mediaDir;
    // Saved copies of contacts' links: web pages as MHTML archives, other files as downloaded.
    private File pagesDir;
    private final java.util.ArrayDeque<String> snapQueue = new java.util.ArrayDeque<>();
    private WebView snapView;
    private String snapUrl;
    private boolean snapSaving;
    private final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable snapSettle = this::scrollSnap, snapGiveUp = this::saveSnap, snapScrolled = this::saveSnap;

    /** Scrolls the page top to bottom so pictures that only load when scrolled into view get loaded. */
    private static final String SCROLL_JS = """
        (function () {
          var y = 0, n = 0;
          var t = setInterval(function () {
            y += Math.max(400, innerHeight * 0.8); scrollTo(0, y); n++;
            if (y >= document.documentElement.scrollHeight || n > 40) { clearInterval(t); scrollTo(0, 0); }
          }, 150);
        })()""";

    /**
     * Every picture on the page worth offering: loaded images (not icons), lazy-load attributes, srcset and
     * <picture> sources (largest), CSS backgrounds of big elements, links straight to picture files, and the
     * page's share image. Unloaded images are kept, since their size isn't known.
     */
    private static final String PICS_JS = """
        (function () {
          var out = [], seen = {};
          function add(u) {
            if (!u) return;
            try { u = new URL(String(u).trim(), location.href).href; } catch (e) { return; }
            if (!/^https?:/.test(u) || /\.svg(\?|#|$)/i.test(u) || seen[u]) return;
            seen[u] = 1; out.push(u);
          }
          function best(set) {
            if (!set) return '';
            var top = '', w = -1;
            set.split(/,\s+/).forEach(function (part) {
              var bits = part.trim().split(/\s+/), v = parseFloat(bits[1]) || 1;
              if (bits[0] && v > w) { w = v; top = bits[0]; }
            });
            return top;
          }
          ['meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[property="og:image:url"]'].forEach(function (q) {
            var m = document.querySelector(q); if (m) add(m.content);
          });
          var l = document.querySelector('link[rel="image_src"]'); if (l) add(l.href);
          Array.prototype.forEach.call(document.images, function (i) {
            var small = (i.complete && i.naturalWidth > 0 && (i.naturalWidth < 100 || i.naturalHeight < 100)) || (i.width > 0 && i.width < 60 && i.height < 60);
            var lazy = i.getAttribute('data-src') || i.getAttribute('data-lazy-src') || i.getAttribute('data-original') || i.getAttribute('data-url') || best(i.getAttribute('data-srcset'));
            if (lazy) add(lazy);
            if (!small) { add(best(i.getAttribute('srcset')) || i.currentSrc || i.src); }
          });
          Array.prototype.forEach.call(document.querySelectorAll('picture source[srcset], picture source[data-srcset]'), function (s) {
            add(best(s.getAttribute('srcset') || s.getAttribute('data-srcset')));
          });
          Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
            if (/\.(jpe?g|png|webp|gif|heic|avif)(\?|#|$)/i.test(a.getAttribute('href'))) add(a.getAttribute('href'));
          });
          Array.prototype.forEach.call(document.querySelectorAll('body *'), function (el) {
            if (out.length > 300) return;
            var r = el.getBoundingClientRect();
            if (r.width < 150 || r.height < 150) return;
            var bg = getComputedStyle(el).backgroundImage, m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
            if (m) add(m[1]);
          });
          return JSON.stringify(out.slice(0, 200));
        })()""";
    private String pendingLookup;
    private String pendingSaveAs;
    // A contact to open once the page is ready, from a tapped timer notification.
    private String pendingOpen;
    // A link to add to a contact: shared from another app, or opened from a "Send to Tof" QR code.
    private String pendingLink, pendingLinkTitle;
    private final ExecutorService downloads = Executors.newFixedThreadPool(3);
    // Log file writes happen one at a time, in order.
    private final ExecutorService logIo = Executors.newSingleThreadExecutor();
    // Copies into the chosen media folder also happen one batch at a time.
    private final ExecutorService mediaIo = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        mediaDir = new File(getFilesDir(), "media");
        mediaDir.mkdirs();
        pagesDir = new File(getFilesDir(), "pages");
        pagesDir.mkdirs();
        assets = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/media/", new WebViewAssetLoader.InternalStoragePathHandler(this, mediaDir))
                .build();

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        web.addJavascriptInterface(new Bridge(), "TofAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                // Links and pictures in messages open in the phone's browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                deliverShares();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingChooser != null) pendingChooser.onReceiveValue(null);
                pendingChooser = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(pick, PICK_FILES);
                } catch (ActivityNotFoundException e) {
                    pendingChooser = null;
                    return false;
                }
                return true;
            }
        });

        collectShares(getIntent());
        collectOpen(getIntent());
        Timers.ensureChannel(this);
        Timers.rescheduleAll(this);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        collectShares(intent);
        collectOpen(intent);
        deliverShares();
    }

    private void collectOpen(Intent intent) {
        if (intent == null || intent.getStringExtra("openContact") == null) return;
        pendingOpen = intent.getStringExtra("openContact");
        String timer = intent.getStringExtra("timer");
        if (timer != null) {
            org.json.JSONObject t = Timers.get(this, timer);
            if (t != null) { try { t.put("done", true); Timers.put(this, timer, t); } catch (Exception ignored) { } }
        }
        intent.removeExtra("openContact");
    }

    private void deliverOpen() {
        if (!pageReady || pendingOpen == null) return;
        String js = "window.__tofOpen && window.__tofOpen(" + JSONObject.quote(pendingOpen) + ")";
        pendingOpen = null;
        web.evaluateJavascript(js, null);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_LOG_FOLDER) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri tree = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    prefs().edit().putString("logTree", tree.toString()).apply();
                } catch (Exception ignored) { }
                logIo.execute(this::sendLogFile);
            }
            return;
        }
        if (requestCode == PICK_MEDIA_FOLDER) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri tree = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    prefs().edit().putString("mediaTree", tree.toString()).apply();
                } catch (Exception ignored) { }
                String js = "window.__tofMediaFolder && window.__tofMediaFolder(" + JSONObject.quote(mediaTree() == null ? "" : folderName(mediaTree())) + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            }
            return;
        }
        if (requestCode == SAVE_MEDIA_AS) {
            String file = pendingSaveAs;
            pendingSaveAs = null;
            Uri dest = resultCode == RESULT_OK && data != null ? data.getData() : null;
            if (dest == null || file == null) return;
            mediaIo.execute(() -> {
                boolean ok = copyTo(new File(mediaDir, file), dest);
                String js = "window.__tofSavedAs && window.__tofSavedAs(" + ok + "," + JSONObject.quote(nameOf(dest)) + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            });
            return;
        }
        if (requestCode != PICK_FILES || pendingChooser == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] { data.getData() };
            }
        }
        pendingChooser.onReceiveValue(result);
        pendingChooser = null;
    }

    @Override
    protected void onDestroy() {
        downloads.shutdownNow();
        logIo.shutdown();
        mediaIo.shutdown();
        if (snapView != null) { snapView.destroy(); snapView = null; }
        super.onDestroy();
    }

    /** Lets the page keep copies of pictures and videos from messages, since TextNow's links expire. */
    private class Bridge {
        @JavascriptInterface
        public void saveMedia(String url) {
            if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
            downloads.execute(() -> download(url));
        }

        /** Looks up saved contact names for a JSON array of numbers; asks for permission the first time. */
        @JavascriptInterface
        public void lookupContacts(String numbersJson, boolean ask) {
            runOnUiThread(() -> {
                if (checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED) {
                    downloads.execute(() -> lookup(numbersJson));
                } else if (ask) {
                    pendingLookup = numbersJson;
                    requestPermissions(new String[] { Manifest.permission.READ_CONTACTS }, ASK_CONTACTS);
                } else {
                    sendContacts(new JSONObject(), "not-asked");
                }
            });
        }

        /**
         * Opens a link in Chrome without history or cookies: an ephemeral Custom Tab, plus the
         * Incognito extra that Chrome honours where it allows it. Falls back to any browser.
         */
        @JavascriptInterface
        public void openPrivate(String url) {
            if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                Bundle b = new Bundle();
                b.putBinder("android.support.customtabs.extra.SESSION", null);
                i.putExtras(b);
                i.putExtra("androidx.browser.customtabs.extra.ENABLE_EPHEMERAL_BROWSING", true);
                i.putExtra("com.google.android.apps.chrome.EXTRA_OPEN_NEW_INCOGNITO_TAB", true);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                i.setPackage("com.android.chrome");
                try {
                    startActivity(i);
                } catch (ActivityNotFoundException e) {
                    i.setPackage(null);
                    try { startActivity(i); } catch (ActivityNotFoundException ignored) { }
                }
            });
        }

        /** Opens the phone's Contacts app with a new contact filled in; the person reviews it and taps Save. */
        @JavascriptInterface
        public void saveContact(String name, String numbersJson) {
            runOnUiThread(() -> {
                Intent i = new Intent(ContactsContract.Intents.Insert.ACTION);
                i.setType(ContactsContract.RawContacts.CONTENT_TYPE);
                if (name != null && !name.isEmpty()) i.putExtra(ContactsContract.Intents.Insert.NAME, name);
                String[] keys = { ContactsContract.Intents.Insert.PHONE, ContactsContract.Intents.Insert.SECONDARY_PHONE, ContactsContract.Intents.Insert.TERTIARY_PHONE };
                try {
                    JSONArray nums = new JSONArray(numbersJson == null ? "[]" : numbersJson);
                    for (int k = 0; k < nums.length() && k < keys.length; k++) i.putExtra(keys[k], nums.getString(k));
                } catch (Exception ignored) { }
                i.putExtra("finishActivityOnSaveCompleted", true);
                try { startActivity(i); } catch (ActivityNotFoundException ignored) { }
            });
        }

        @JavascriptInterface
        public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
        }

        /** Asks for a folder (outside the app's own storage) to keep the activity log in, so it outlives a reinstall. */
        @JavascriptInterface
        public void pickLogFolder() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try { startActivityForResult(i, PICK_LOG_FOLDER); } catch (ActivityNotFoundException ignored) { }
            });
        }

        /** The chosen log folder's name, or "" when none is chosen or access was lost. */
        @JavascriptInterface
        public String logFolder() {
            Uri tree = logTree();
            return tree == null ? "" : folderName(tree);
        }

        /** Sends the log file's text to the page (window.__tofLogFile). */
        @JavascriptInterface
        public void readLog() { logIo.execute(MainActivity.this::sendLogFile); }

        @JavascriptInterface
        public void appendLog(String lines) { logIo.execute(() -> writeLog(lines, true)); }

        @JavascriptInterface
        public void rewriteLog(String text) { logIo.execute(() -> writeLog(text, false)); }

        @JavascriptInterface
        public void checkMedia(String url, String etag, String lastMod) {
            if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
            downloads.execute(() -> check(url, etag, lastMod));
        }

        /** Asks for a folder to keep copies of saved pictures and videos in, outside Tof's own storage. */
        @JavascriptInterface
        public void pickMediaFolder() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try { startActivityForResult(i, PICK_MEDIA_FOLDER); } catch (ActivityNotFoundException ignored) { }
            });
        }

        @JavascriptInterface
        public String mediaFolder() {
            Uri tree = mediaTree();
            return tree == null ? "" : folderName(tree);
        }

        /**
         * Copies saved files into the media folder: a JSON array of {file, name, token}. A file is skipped when
         * the folder already has one whose name contains its token, so renamed contacts don't make duplicates.
         * Reports back through __tofMediaCopied(tokens now in the folder, newly copied, failed).
         */
        @JavascriptInterface
        public void copyMedia(String itemsJson) { mediaIo.execute(() -> copyAll(itemsJson)); }

        /** Lets the person pick where to save one saved file (Android's save dialog). */
        @JavascriptInterface
        public void saveMediaAs(String file, String name, String mime) {
            if (file == null || file.contains("/") || !new File(mediaDir, file).isFile()) return;
            runOnUiThread(() -> {
                pendingSaveAs = file;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, SAVE_MEDIA_AS); } catch (ActivityNotFoundException e) { pendingSaveAs = null; }
            });
        }

        /** A short buzz, used when a long press is recognised. */
        @JavascriptInterface
        public void buzz() { runOnUiThread(() -> web.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)); }

        /** Sets (or replaces) a contact timer; Android notifies at `at` even if Tof is closed. */
        @JavascriptInterface
        public void setTimer(String id, double at, String title, String text, String open) {
            if (id == null || id.isEmpty()) return;
            Timers.set(MainActivity.this, id, (long) at, title, text, open);
        }

        @JavascriptInterface
        public void cancelTimer(String id) { if (id != null) Timers.cancel(MainActivity.this, id); }

        /** Every timer Android knows about, as JSON {id: {at, done, fired, snoozed}}: snoozes and Done taps happen outside the page. */
        @JavascriptInterface
        public String timers() { return Timers.all(MainActivity.this).toString(); }

        /** "on", "off" (blocked or not allowed yet) and whether alarms can be exact. */
        @JavascriptInterface
        public String notifyState() {
            boolean on = ((android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE)).areNotificationsEnabled()
                    && (android.os.Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
            return (on ? "on" : "off") + (Timers.exact(MainActivity.this) ? "" : ",inexact");
        }

        /** Asks to show notifications (Android 13+), or opens Tof's notification settings if that was refused before. */
        @JavascriptInterface
        public void askNotify() {
            runOnUiThread(() -> {
                if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                        && !prefs().getBoolean("askedNotify", false)) {
                    prefs().edit().putBoolean("askedNotify", true).apply();
                    requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, ASK_NOTIFY);
                    return;
                }
                Intent i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
                try { startActivity(i); } catch (ActivityNotFoundException ignored) { }
            });
        }

        /** Saves a copy of a link: a web page as an archive, anything else (PDF, picture) as the file itself. */
        @JavascriptInterface
        public void snapshot(String url) {
            if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
            downloads.execute(() -> probe(url));
        }

        /** Opens a saved copy: archives in Tof's offline viewer, other files in whatever app handles them. */
        @JavascriptInterface
        public void openSaved(String file, String mime) {
            if (file == null || file.contains("/") || !new File(pagesDir, file).isFile()) return;
            runOnUiThread(() -> {
                if (file.endsWith(".mht")) {
                    startActivity(new Intent(MainActivity.this, PageActivity.class).putExtra("file", file));
                    return;
                }
                Uri uri = androidx.core.content.FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", new File(pagesDir, file));
                Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime == null || mime.isEmpty() ? "*/*" : mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { startActivity(i); } catch (ActivityNotFoundException ignored) { }
            });
        }

        /**
         * Turns a saved picture by 90, 180 or 270 degrees, rewriting the file. Reports back through
         * __tofRotated(file, ok) once done.
         */
        @JavascriptInterface
        public void rotateMedia(String file, int degrees) {
            if (file == null || file.contains("/")) return;
            downloads.execute(() -> {
                boolean ok = rotateFile(new File(mediaDir, file), degrees);
                String js = "window.__tofRotated && window.__tofRotated(" + JSONObject.quote(file) + "," + ok + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            });
        }

        /** Sends the content hash of saved files (a JSON array of names) to __tofMediaHash(file, hash). */
        @JavascriptInterface
        public void hashMedia(String filesJson) {
            downloads.execute(() -> {
                try {
                    JSONArray files = new JSONArray(filesJson);
                    for (int i = 0; i < files.length(); i++) {
                        String file = files.getString(i);
                        if (file.contains("/")) continue;
                        String h = fileHash(new File(mediaDir, file));
                        String js = "window.__tofMediaHash && window.__tofMediaHash(" + JSONObject.quote(file) + "," + JSONObject.quote(h) + ")";
                        web.post(() -> web.evaluateJavascript(js, null));
                    }
                } catch (Exception ignored) { }
            });
        }

        /** Removes a saved picture or video that turned out to be a copy of another. */
        @JavascriptInterface
        public void deleteMedia(String file) {
            if (file != null && !file.contains("/")) new File(mediaDir, file).delete();
        }

        @JavascriptInterface
        public void deleteSaved(String file) {
            if (file != null && !file.contains("/")) new File(pagesDir, file).delete();
        }

        @JavascriptInterface
        public void clearMedia() {
            File[] pages = pagesDir.listFiles();
            if (pages != null) for (File f : pages) f.delete();
            File[] files = mediaDir.listFiles();
            if (files != null) for (File f : files) f.delete();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == ASK_NOTIFY) {
            web.evaluateJavascript("window.__tofNotifyChanged && window.__tofNotifyChanged()", null);
            return;
        }
        if (requestCode != ASK_CONTACTS) return;
        String numbers = pendingLookup;
        pendingLookup = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && numbers != null) {
            downloads.execute(() -> lookup(numbers));
        } else {
            sendContacts(new JSONObject(), "denied");
        }
    }

    /**
     * Reads, never writes, the phone's contacts: a name per number plus everything saved on the matching
     * contact (numbers, emails, addresses, company, birthday, websites, note) so Tof can keep a copy.
     */
    private void lookup(String numbersJson) {
        JSONObject names = new JSONObject(), details = new JSONObject();
        JSONObject byContact = new JSONObject();
        try {
            JSONArray numbers = new JSONArray(numbersJson);
            for (int i = 0; i < numbers.length(); i++) {
                String number = numbers.getString(i);
                Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
                long id = -1;
                try (Cursor c = getContentResolver().query(uri, new String[] { ContactsContract.PhoneLookup.DISPLAY_NAME, ContactsContract.PhoneLookup._ID }, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        if (c.getString(0) != null) names.put(number, c.getString(0));
                        id = c.getLong(1);
                    }
                } catch (Exception ignored) {
                }
                if (id < 0) continue;
                String key = String.valueOf(id);
                if (!byContact.has(key)) byContact.put(key, readContact(id));
                details.put(number, byContact.getJSONObject(key));
            }
        } catch (Exception ignored) {
        }
        sendContacts(names, "granted", details);
    }

    private JSONObject readContact(long id) {
        JSONObject out = new JSONObject();
        JSONArray phones = new JSONArray(), emails = new JSONArray(), addresses = new JSONArray(), sites = new JSONArray();
        try {
            out.put("id", id);
            String[] cols = { ContactsContract.Data.MIMETYPE, ContactsContract.Data.DATA1, ContactsContract.Data.DATA2, ContactsContract.Data.DATA3, ContactsContract.Data.DATA4 };
            try (Cursor c = getContentResolver().query(ContactsContract.Data.CONTENT_URI, cols, ContactsContract.Data.CONTACT_ID + "=?", new String[] { String.valueOf(id) }, null)) {
                while (c != null && c.moveToNext()) {
                    String mime = c.getString(0), d1 = c.getString(1);
                    if (mime == null || d1 == null || d1.trim().isEmpty()) continue;
                    int type = c.isNull(2) ? 0 : c.getInt(2);
                    String custom = c.getString(3);
                    switch (mime) {
                        case ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE:
                            out.put("name", d1); break;
                        case ContactsContract.CommonDataKinds.Nickname.CONTENT_ITEM_TYPE:
                            out.put("nickname", d1); break;
                        case ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE:
                            phones.put(new JSONObject().put("value", d1).put("label", ContactsContract.CommonDataKinds.Phone.getTypeLabel(getResources(), type, custom).toString())); break;
                        case ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE:
                            emails.put(new JSONObject().put("value", d1).put("label", ContactsContract.CommonDataKinds.Email.getTypeLabel(getResources(), type, custom).toString())); break;
                        case ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE:
                            addresses.put(new JSONObject().put("value", d1).put("label", ContactsContract.CommonDataKinds.StructuredPostal.getTypeLabel(getResources(), type, custom).toString())); break;
                        case ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE:
                            out.put("company", d1);
                            if (c.getString(4) != null) out.put("title", c.getString(4));
                            break;
                        case ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE:
                            sites.put(d1); break;
                        case ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE:
                            out.put("note", d1); break;
                        case ContactsContract.CommonDataKinds.Event.CONTENT_ITEM_TYPE:
                            if (type == ContactsContract.CommonDataKinds.Event.TYPE_BIRTHDAY) out.put("birthday", d1);
                            break;
                        default: break;
                    }
                }
            }
            out.put("phones", phones).put("emails", emails).put("addresses", addresses).put("websites", sites);
        } catch (Exception ignored) {
        }
        return out;
    }

    private SharedPreferences prefs() { return getSharedPreferences("tof", MODE_PRIVATE); }

    private Uri logTree() {
        String t = prefs().getString("logTree", null);
        if (t == null) return null;
        Uri tree = Uri.parse(t);
        for (android.content.UriPermission p : getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(tree) && p.isWritePermission()) return tree;
        }
        return null;
    }

    private Uri mediaTree() {
        String t = prefs().getString("mediaTree", null);
        if (t == null) return null;
        Uri tree = Uri.parse(t);
        for (android.content.UriPermission p : getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(tree) && p.isWritePermission()) return tree;
        }
        return null;
    }

    private boolean copyTo(File src, Uri dest) {
        try (InputStream in = new java.io.FileInputStream(src); OutputStream out = getContentResolver().openOutputStream(dest, "wt")) {
            if (out == null) return false;
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void copyAll(String itemsJson) {
        JSONArray done = new JSONArray();
        int failed = 0, made = 0;
        Uri tree = mediaTree();
        if (tree != null) {
            String parent = DocumentsContract.getTreeDocumentId(tree);
            Uri parentDoc = DocumentsContract.buildDocumentUriUsingTree(tree, parent);
            List<String> have = new ArrayList<>(), ids = new ArrayList<>();
            String[] cols = { DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_DOCUMENT_ID };
            try (Cursor c = getContentResolver().query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent), cols, null, null, null)) {
                while (c != null && c.moveToNext()) if (c.getString(0) != null) { have.add(c.getString(0)); ids.add(c.getString(1)); }
            } catch (Exception ignored) { }
            try {
                JSONArray items = new JSONArray(itemsJson);
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.getJSONObject(i);
                    String file = it.optString("file"), name = it.optString("name"), token = it.optString("token");
                    File src = new File("pages".equals(it.optString("dir")) ? pagesDir : mediaDir, file);
                    if (file.isEmpty() || file.contains("/") || token.isEmpty() || !src.isFile()) continue;
                    boolean present = false;
                    for (String h : have) if (h.contains(token)) { present = true; break; }
                    String replace = it.optString("replace");
                    if (!present && !replace.isEmpty()) {
                        for (int k = have.size() - 1; k >= 0; k--) {
                            if (!have.get(k).contains(replace)) continue;
                            try { DocumentsContract.deleteDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, ids.get(k))); } catch (Exception ignored) { }
                            have.remove(k);
                            ids.remove(k);
                        }
                    }
                    if (!present) {
                        Uri dest = null;
                        try { dest = DocumentsContract.createDocument(getContentResolver(), parentDoc, mimeForExt(file), name); } catch (Exception ignored) { }
                        if (dest == null || !copyTo(src, dest)) {
                            failed++;
                            if (dest != null) { try { DocumentsContract.deleteDocument(getContentResolver(), dest); } catch (Exception ignored) { } }
                            continue;
                        }
                        have.add(name);
                        ids.add("");
                        made++;
                    }
                    done.put(token);
                }
            } catch (Exception ignored) { }
        }
        String js = "window.__tofMediaCopied && window.__tofMediaCopied(" + done + "," + made + "," + failed + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private String folderName(Uri tree) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        int colon = id.indexOf(':');
        String path = colon >= 0 ? id.substring(colon + 1) : id;
        return path.isEmpty() ? "Internal storage" : path;
    }

    /** Finds tof-log.txt in the chosen folder, creating it when asked. */
    private Uri logFile(boolean create) {
        Uri tree = logTree();
        if (tree == null) return null;
        String parent = DocumentsContract.getTreeDocumentId(tree);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent);
        String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME };
        try (Cursor c = getContentResolver().query(children, cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                if (LOG_NAME.equals(c.getString(1))) return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
            }
        } catch (Exception e) {
            return null;
        }
        if (!create) return null;
        try {
            return DocumentsContract.createDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, parent), "text/plain", LOG_NAME);
        } catch (Exception e) {
            return null;
        }
    }

    private void writeLog(String text, boolean append) {
        Uri file = logFile(true);
        if (file == null || text == null) return;
        try (OutputStream out = getContentResolver().openOutputStream(file, append ? "wa" : "wt")) {
            if (out != null) out.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }

    private void sendLogFile() {
        Uri tree = logTree();
        String text = "";
        Uri file = logFile(false);
        if (file != null) {
            try (InputStream in = getContentResolver().openInputStream(file)) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] b = new byte[8192];
                int n;
                while (in != null && (n = in.read(b)) > 0) buf.write(b, 0, n);
                text = buf.toString("UTF-8");
            } catch (Exception ignored) { }
        }
        String js = "window.__tofLogFile && window.__tofLogFile(" + JSONObject.quote(text) + "," + JSONObject.quote(tree == null ? "" : folderName(tree)) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private void sendContacts(JSONObject names, String state) { sendContacts(names, state, new JSONObject()); }
    private void sendContacts(JSONObject names, String state, JSONObject details) {
        String js = "window.__tofContacts && window.__tofContacts(" + names + "," + JSONObject.quote(state) + "," + details + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private void download(String url) {
        String base = sha1(url);
        File[] existing = mediaDir.listFiles((dir, name) -> name.startsWith(base + "."));
        if (existing != null && existing.length > 0) {
            File f = existing[0];
            report(url, "saved", f.getName(), mimeForExt(f.getName()), f.length(), "", "", fileHash(f));
            return;
        }
        HttpURLConnection conn = null;
        File tmp = new File(mediaDir, base + ".part");
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) Tof");
            int code = conn.getResponseCode();
            // Expired TextNow media links answer 403 Access Denied (S3) or 404/410.
            if (code >= 400) { report(url, code == 403 || code == 404 || code == 410 ? "gone" : "failed", "", "", 0); return; }
            String etag = header(conn, "ETag"), lastMod = header(conn, "Last-Modified");
            String type = conn.getContentType() == null ? "" : conn.getContentType().split(";")[0].trim().toLowerCase(Locale.US);
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] head = new byte[32];
                int got = 0, n;
                while (got < head.length && (n = in.read(head, got, head.length - got)) > 0) got += n;
                String mime = type.startsWith("image/") || type.startsWith("video/") ? type : sniff(head, got);
                if (mime == null) { out.close(); tmp.delete(); report(url, "notmedia", "", "", 0); return; }
                out.write(head, 0, got);
                long total = got;
                byte[] buf = new byte[65536];
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_MEDIA_BYTES) throw new Exception("too large");
                    out.write(buf, 0, n);
                }
                out.close();
                File dest = new File(mediaDir, base + "." + extFor(mime));
                if (!tmp.renameTo(dest)) throw new Exception("rename failed");
                report(url, "saved", dest.getName(), mime, total, etag, lastMod, fileHash(dest));
            }
        } catch (Exception e) {
            tmp.delete();
            report(url, "failed", "", "", 0);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void report(String url, String status, String file, String mime, long size) { report(url, status, file, mime, size, "", ""); }
    private void report(String url, String status, String file, String mime, long size, String etag, String lastMod) { report(url, status, file, mime, size, etag, lastMod, ""); }
    private void report(String url, String status, String file, String mime, long size, String etag, String lastMod, String hash) {
        String local = file.isEmpty() ? "" : "https://" + HOST + "/media/" + file;
        String js = "window.__tofMediaDone && window.__tofMediaDone(" + JSONObject.quote(url) + "," + JSONObject.quote(status) + ","
                + JSONObject.quote(local) + "," + JSONObject.quote(mime) + "," + size + "," + JSONObject.quote(etag) + "," + JSONObject.quote(lastMod) + "," + JSONObject.quote(hash) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    /** Looks at what a link points to. Web pages go to the snapshot queue; other files are saved directly. */
    private void probe(String url) {
        String base = "p-" + sha1(url).substring(0, 10) + "-" + System.currentTimeMillis();
        HttpURLConnection conn = null;
        File tmp = new File(pagesDir, base + ".part");
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36");
            int code = conn.getResponseCode();
            String type = conn.getContentType() == null ? "" : conn.getContentType().split(";")[0].trim().toLowerCase(Locale.US);
            if (type.isEmpty() || type.contains("html") || code >= 400) {
                // A page (or one that refuses plain downloads): let a browser engine load it.
                conn.disconnect();
                conn = null;
                runOnUiThread(() -> { snapQueue.add(url); nextSnap(); });
                return;
            }
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[65536];
                long total = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_MEDIA_BYTES) throw new Exception("too large");
                    out.write(buf, 0, n);
                }
                out.close();
                File dest = new File(pagesDir, base + "." + pageExt(type, url));
                if (!tmp.renameTo(dest)) throw new Exception("rename failed");
                reportPage(url, "saved", dest.getName(), type, total, "");
            }
        } catch (Exception e) {
            tmp.delete();
            reportPage(url, "failed", "", "", 0, "");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String pageExt(String mime, String url) {
        if (mime.equals("application/pdf")) return "pdf";
        if (mime.startsWith("image/") || mime.startsWith("video/")) return extFor(mime);
        if (mime.equals("text/plain")) return "txt";
        String path = Uri.parse(url).getLastPathSegment();
        int dot = path == null ? -1 : path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase(Locale.US) : "";
        return ext.matches("[a-z0-9]{1,5}") ? ext : "bin";
    }

    /** Loads the next queued page in an off-screen browser; once it settles, saves it as an archive. */
    private void nextSnap() {
        if (snapView != null || snapQueue.isEmpty()) return;
        snapUrl = snapQueue.poll();
        snapSaving = false;
        snapView = new WebView(this);
        WebSettings s = snapView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadsImagesAutomatically(true);
        // Attached but moved off screen, so the page behaves as if it's showing (lazy pictures load) without being seen.
        android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
        addContentView(snapView, new android.view.ViewGroup.LayoutParams(dm.widthPixels, dm.heightPixels));
        snapView.setTranslationX(dm.widthPixels * 3f);
        snapView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // Pages keep loading pictures and text after "finished"; wait for them to settle.
                ui.removeCallbacks(snapSettle);
                ui.postDelayed(snapSettle, 3000);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) finishSnap("failed", "", "");
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                return !("http".equals(scheme) || "https".equals(scheme));
            }
        });
        ui.postDelayed(snapGiveUp, 60000);
        snapView.loadUrl(snapUrl);
    }

    private void scrollSnap() {
        if (snapView == null) return;
        ui.removeCallbacks(snapSettle);
        snapView.evaluateJavascript(SCROLL_JS, null);
        // ~40 steps of 150 ms, then a moment for the last pictures to arrive.
        ui.removeCallbacks(snapScrolled);
        ui.postDelayed(snapScrolled, 8000);
    }

    private void saveSnap() {
        if (snapView == null || snapSaving) return;
        snapSaving = true;
        ui.removeCallbacks(snapScrolled);
        ui.removeCallbacks(snapSettle);
        ui.removeCallbacks(snapGiveUp);
        String name = "p-" + sha1(snapUrl).substring(0, 10) + "-" + System.currentTimeMillis() + ".mht";
        String title = snapView.getTitle() == null ? "" : snapView.getTitle();
        // The page's real pictures (not icons), so Bob can pick some for the contact's media.
        WebView view = snapView;
        view.evaluateJavascript(PICS_JS, found -> {
            if (snapView != view) return;
            String images = "[]";
            try { images = new JSONArray(new org.json.JSONTokener(found).nextValue().toString()).toString(); } catch (Exception ignored) { }
            String imgs = images;
            view.saveWebArchive(new File(pagesDir, name).getPath(), false, path -> {
                if (path == null) finishSnap("failed", "", title, imgs);
                else finishSnap("saved", name, title, imgs);
            });
        });
    }

    private void finishSnap(String status, String name, String title) { finishSnap(status, name, title, "[]"); }
    private void finishSnap(String status, String name, String title, String images) {
        if (snapView == null) return;
        ui.removeCallbacks(snapSettle);
        ui.removeCallbacks(snapGiveUp);
        ui.removeCallbacks(snapScrolled);
        String url = snapUrl;
        if (snapView.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) snapView.getParent()).removeView(snapView);
        File f = name.isEmpty() ? null : new File(pagesDir, name);
        snapView.stopLoading();
        snapView.destroy();
        snapView = null;
        snapUrl = null;
        reportPage(url, status, name, "multipart/related", f == null ? 0 : f.length(), title, images);
        nextSnap();
    }

    private void reportPage(String url, String status, String file, String mime, long size, String title) { reportPage(url, status, file, mime, size, title, "[]"); }
    private void reportPage(String url, String status, String file, String mime, long size, String title, String images) {
        String js = "window.__tofPageDone && window.__tofPageDone(" + JSONObject.quote(url) + "," + JSONObject.quote(status) + "," + JSONObject.quote(file) + ","
                + JSONObject.quote(mime) + "," + size + "," + JSONObject.quote(title) + "," + images + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    /**
     * Rewrites a saved picture turned by `degrees` from how it looks on screen. Phone photos often store
     * their pixels sideways with an EXIF "orientation" tag that viewers obey, so that tag is applied first
     * and dropped from the new file; otherwise the turn would cancel out against it.
     */
    private static boolean rotateFile(File f, int degrees) {
        if (!f.isFile()) return false;
        String name = f.getName().toLowerCase(Locale.US);
        int exif = 0;
        try {
            switch (new android.media.ExifInterface(f.getPath()).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) {
                case android.media.ExifInterface.ORIENTATION_ROTATE_90: exif = 90; break;
                case android.media.ExifInterface.ORIENTATION_ROTATE_180: exif = 180; break;
                case android.media.ExifInterface.ORIENTATION_ROTATE_270: exif = 270; break;
                default: break;
            }
        } catch (Exception ignored) { }
        int d = (((degrees + exif) % 360) + 360) % 360;
        android.graphics.Bitmap src = android.graphics.BitmapFactory.decodeFile(f.getPath());
        if (src == null) return false;
        android.graphics.Matrix m = new android.graphics.Matrix();
        m.postRotate(d);
        android.graphics.Bitmap out = d == 0 ? src : android.graphics.Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), m, true);
        // PNG and WebP keep their format; everything else (JPEG, HEIC, GIF) is written as JPEG.
        android.graphics.Bitmap.CompressFormat fmt = name.endsWith(".png") ? android.graphics.Bitmap.CompressFormat.PNG
                : name.endsWith(".webp") ? android.graphics.Bitmap.CompressFormat.WEBP : android.graphics.Bitmap.CompressFormat.JPEG;
        File tmp = new File(f.getPath() + ".rot");
        boolean ok;
        try (OutputStream o = new FileOutputStream(tmp)) {
            ok = out.compress(fmt, 92, o);
        } catch (Exception e) {
            ok = false;
        } finally {
            if (out != src) out.recycle();
            src.recycle();
        }
        if (!ok) { tmp.delete(); return false; }
        return tmp.renameTo(f);
    }

    /** SHA-1 of a file's bytes, so the same picture saved from two links is recognised. */
    private static String fileHash(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte x : md.digest()) sb.append(String.format(Locale.US, "%02x", x));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String header(HttpURLConnection c, String name) { String v = c.getHeaderField(name); return v == null ? "" : v; }

    /**
     * Asks the server whether a saved file has changed, fetching at most one byte: a conditional ranged GET
     * (TextNow's signed links don't allow HEAD). Unchanged: "same". Link expired: "offline". Changed: the old
     * file is kept as old-<name> and the new version is downloaded, which then reports through __tofMediaDone.
     */
    private void check(String url, String etag, String lastMod) {
        String base = sha1(url);
        File[] existing = mediaDir.listFiles((dir, name) -> name.startsWith(base + "."));
        File saved = existing != null && existing.length > 0 ? existing[0] : null;
        HttpURLConnection conn = null;
        String result = "error", newTag = "", newMod = "", oldLocal = "";
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) Tof");
            conn.setRequestProperty("Range", "bytes=0-0");
            if (etag != null && !etag.isEmpty()) conn.setRequestProperty("If-None-Match", etag);
            if (lastMod != null && !lastMod.isEmpty()) conn.setRequestProperty("If-Modified-Since", lastMod);
            int code = conn.getResponseCode();
            newTag = header(conn, "ETag");
            newMod = header(conn, "Last-Modified");
            if (code == 304) {
                result = "same";
                if (newTag.isEmpty()) newTag = etag == null ? "" : etag;
            } else if (code == 403 || code == 404 || code == 410) {
                result = "offline";
            } else if (code == 200 || code == 206) {
                long remoteSize = -1;
                String range = header(conn, "Content-Range");
                int slash = range.lastIndexOf('/');
                if (slash >= 0) { try { remoteSize = Long.parseLong(range.substring(slash + 1).trim()); } catch (Exception ignored) { } }
                else if (code == 200) remoteSize = conn.getContentLengthLong();
                boolean same = etag != null && !etag.isEmpty() ? etag.equals(newTag)
                        : saved != null && remoteSize >= 0 && remoteSize == saved.length();
                if (same || saved == null) {
                    result = "same";
                } else {
                    File old = new File(mediaDir, "old-" + System.currentTimeMillis() + "-" + saved.getName());
                    if (saved.renameTo(old)) {
                        oldLocal = "https://" + HOST + "/media/" + old.getName();
                        result = "changed";
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
        String js = "window.__tofMediaCheck && window.__tofMediaCheck(" + JSONObject.quote(url) + "," + JSONObject.quote(result) + ","
                + JSONObject.quote(newTag) + "," + JSONObject.quote(newMod) + "," + JSONObject.quote(oldLocal) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
        if (result.equals("changed")) download(url);
    }

    private static String sniff(byte[] b, int n) {
        if (n >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8) return "image/jpeg";
        if (n >= 4 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
        if (n >= 4 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8') return "image/gif";
        if (n >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        if (n >= 12 && b[4] == 'f' && b[5] == 't' && b[6] == 'y' && b[7] == 'p') {
            String brand = new String(b, 8, 4, StandardCharsets.US_ASCII);
            if (brand.startsWith("hei") || brand.startsWith("mif1") || brand.startsWith("hev")) return "image/heic";
            if (brand.startsWith("3g")) return "video/3gpp";
            if (brand.startsWith("qt")) return "video/quicktime";
            return "video/mp4";
        }
        if (n >= 4 && (b[0] & 0xff) == 0x1a && (b[1] & 0xff) == 0x45 && (b[2] & 0xff) == 0xdf && (b[3] & 0xff) == 0xa3) return "video/webm";
        return null;
    }

    private static String extFor(String mime) {
        switch (mime) {
            case "image/jpeg": return "jpg";
            case "image/png": return "png";
            case "image/gif": return "gif";
            case "image/webp": return "webp";
            case "image/heic": case "image/heif": return "heic";
            case "video/3gpp": return "3gp";
            case "video/quicktime": return "mov";
            case "video/webm": return "webm";
            default: return mime.startsWith("video/") ? "mp4" : "img";
        }
    }

    private static String mimeForExt(String name) {
        String ext = name.substring(name.lastIndexOf('.') + 1);
        switch (ext) {
            case "jpg": return "image/jpeg";
            case "png": return "image/png";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "heic": return "image/heic";
            case "3gp": return "video/3gpp";
            case "mov": return "video/quicktime";
            case "webm": return "video/webm";
            case "mp4": return "video/mp4";
            case "mht": return "multipart/related";
            case "pdf": return "application/pdf";
            case "txt": return "text/plain";
            default: return "image/*";
        }
    }

    private static String sha1(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte x : d) sb.append(String.format(Locale.US, "%02x", x));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    private void collectShares(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (uri != null) pendingShares.add(uri);
            else if (isLink(text)) { pendingLink = text.trim(); pendingLinkTitle = intent.getStringExtra(Intent.EXTRA_SUBJECT); }
            else pendingText = text;
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null) pendingShares.addAll(uris);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null && "tof".equals(intent.getData().getScheme())) {
            // tof://add?u=<link>&t=<title>, from the Send to Tof page.
            Uri d = intent.getData();
            String u = d.getQueryParameter("u");
            if (u != null && (u.startsWith("https://") || u.startsWith("http://"))) { pendingLink = u; pendingLinkTitle = d.getQueryParameter("t"); }
            intent.setData(null);
        }
        // Handle each share once, even if the activity is recreated.
        intent.setAction(Intent.ACTION_MAIN);
    }

    /** Text that is just a link (maybe with a title line), not a conversation export. */
    private static boolean isLink(String text) {
        if (text == null) return false;
        String t = text.trim();
        return t.length() < 4000 && t.matches("(?s).*https?://\\S+.*") && !t.contains(" UTC - ");
    }

    private void deliverLink() {
        if (!pageReady || pendingLink == null) return;
        String js = "window.__tofLink && window.__tofLink(" + JSONObject.quote(pendingLink) + "," + JSONObject.quote(pendingLinkTitle == null ? "" : pendingLinkTitle) + ")";
        pendingLink = null;
        pendingLinkTitle = null;
        web.evaluateJavascript(js, null);
    }

    private void deliverShares() {
        deliverOpen();
        deliverLink();
        if (!pageReady || (pendingShares.isEmpty() && pendingText == null)) return;
        JSONArray items = new JSONArray();
        try {
            for (Uri uri : pendingShares) {
                String text = readText(uri);
                if (text != null) items.put(new JSONObject().put("name", nameOf(uri)).put("text", text));
            }
            if (pendingText != null) items.put(new JSONObject().put("name", "shared.txt").put("text", pendingText));
        } catch (Exception ignored) {
        }
        pendingShares.clear();
        pendingText = null;
        if (items.length() > 0) {
            web.evaluateJavascript("window.__tofReceive && window.__tofReceive(" + items + ")", null);
        }
    }

    private String readText(Uri uri) {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0 && out.size() < MAX_BYTES) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    private String nameOf(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null) return name;
            }
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "shared.html";
    }
}
