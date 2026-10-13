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
    private static final int MAX_BYTES = 20 * 1024 * 1024;
    private static final long MAX_MEDIA_BYTES = 300L * 1024 * 1024;

    private WebView web;
    private WebViewAssetLoader assets;
    private ValueCallback<Uri[]> pendingChooser;
    private final List<Uri> pendingShares = new ArrayList<>();
    private String pendingText;
    private boolean pageReady;
    private File mediaDir;
    private String pendingLookup;
    private final ExecutorService downloads = Executors.newFixedThreadPool(3);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        mediaDir = new File(getFilesDir(), "media");
        mediaDir.mkdirs();
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
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        collectShares(intent);
        deliverShares();
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

        @JavascriptInterface
        public void clearMedia() {
            File[] files = mediaDir.listFiles();
            if (files != null) for (File f : files) f.delete();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != ASK_CONTACTS) return;
        String numbers = pendingLookup;
        pendingLookup = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && numbers != null) {
            downloads.execute(() -> lookup(numbers));
        } else {
            sendContacts(new JSONObject(), "denied");
        }
    }

    private void lookup(String numbersJson) {
        JSONObject names = new JSONObject();
        try {
            JSONArray numbers = new JSONArray(numbersJson);
            for (int i = 0; i < numbers.length(); i++) {
                String number = numbers.getString(i);
                Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
                try (Cursor c = getContentResolver().query(uri, new String[] { ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst() && c.getString(0) != null) names.put(number, c.getString(0));
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        }
        sendContacts(names, "granted");
    }

    private void sendContacts(JSONObject names, String state) {
        String js = "window.__tofContacts && window.__tofContacts(" + names + "," + JSONObject.quote(state) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private void download(String url) {
        String base = sha1(url);
        File[] existing = mediaDir.listFiles((dir, name) -> name.startsWith(base + "."));
        if (existing != null && existing.length > 0) {
            File f = existing[0];
            report(url, "saved", f.getName(), mimeForExt(f.getName()), f.length());
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
                report(url, "saved", dest.getName(), mime, total);
            }
        } catch (Exception e) {
            tmp.delete();
            report(url, "failed", "", "", 0);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void report(String url, String status, String file, String mime, long size) {
        String local = file.isEmpty() ? "" : "https://" + HOST + "/media/" + file;
        String js = "window.__tofMediaDone && window.__tofMediaDone(" + JSONObject.quote(url) + "," + JSONObject.quote(status) + ","
                + JSONObject.quote(local) + "," + JSONObject.quote(mime) + "," + size + ")";
        web.post(() -> web.evaluateJavascript(js, null));
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
            if (uri != null) pendingShares.add(uri);
            else pendingText = intent.getStringExtra(Intent.EXTRA_TEXT);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null) pendingShares.addAll(uris);
        }
        // Handle each share once, even if the activity is recreated.
        intent.setAction(Intent.ACTION_MAIN);
    }

    private void deliverShares() {
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
