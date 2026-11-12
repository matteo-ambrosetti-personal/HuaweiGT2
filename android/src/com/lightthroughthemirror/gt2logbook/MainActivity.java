package com.lightthroughthemirror.gt2logbook;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * GT 2 Logbook for Android: the standalone page (dist/web), bundled in the APK
 * and shown in a WebView.
 *
 * The page is served from https://appassets.androidplatform.net/ (the host
 * Android reserves for app assets), so it runs in a secure origin with
 * IndexedDB, and its data stays in this app's private storage. Nothing is
 * loaded from the network except what the page fetches itself: OpenStreetMap
 * map data, when you press Download map. Links to anywhere else open in the
 * browser.
 *
 * What a browser does for the page and a WebView does not, this class does:
 * the file picker for imports, and saving exports (Bridge.java).
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START = "https://" + HOST + "/index.html";

    private static final int REQ_OPEN = 1;
    private static final int REQ_SAVE = 2;

    private WebView web;
    private Bridge bridge;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.bg));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);

        bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "GT2Native");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        bridge.clearLeftovers();
        if (saved == null || web.restoreState(saved) == null) web.loadUrl(START);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        // The page routes with #hash: Back walks back through the tabs first.
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("GT2Native");
            web.destroy();
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------ serving the page

    private static final Map<String, String> TYPES = new HashMap<String, String>();
    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("json", "application/json");
        TYPES.put("webmanifest", "application/manifest+json");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("png", "image/png");
        TYPES.put("svg", "image/svg+xml");
    }

    private WebResourceResponse asset(Uri url) {
        String path = url.getPath();
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-cache");
        if (path.contains("..")) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
        String type = TYPES.containsKey(ext) ? TYPES.get(ext) : "application/octet-stream";
        try {
            InputStream in = getAssets().open("web" + path);
            return new WebResourceResponse(type, type.startsWith("text/") || ext.equals("json") ? "utf-8" : null, 200, "OK", headers, in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
    }

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (HOST.equals(url.getHost())) return asset(url);
            return null; // OpenStreetMap's data service, fetched by the page
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri uri = Uri.parse(url);
            if (HOST.equals(uri.getHost())) return false;
            // Anywhere else belongs in the browser, not in the logbook's window.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, url, Toast.LENGTH_LONG).show();
            }
            return true;
        }
    }

    // ------------------------------------------------------------ picking files

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            // Any type: a Huawei export is a .zip that file managers label in several ways.
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(pick, REQ_OPEN);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                Toast.makeText(MainActivity.this, R.string.no_picker, Toast.LENGTH_LONG).show();
                return false;
            }
        }
    }

    // ------------------------------------------------------------ saving files

    /** Ask where to save an export the bridge has received (UI thread). */
    void askWhereToSave(String name, String mime) {
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        save.addCategory(Intent.CATEGORY_OPENABLE);
        save.setType(mime);
        save.putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(save, REQ_SAVE);
        } catch (ActivityNotFoundException e) {
            bridge.cancelSave("error");
        }
    }

    /** Tell the page how a save ended (any thread). */
    void reportSaved(final String id, final String result) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                // id and result are checked by Bridge: letters, digits, - and _ only.
                web.evaluateJavascript("window.GT2NativeSaved&&window.GT2NativeSaved('" + id + "','" + result + "')", null);
            }
        });
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == REQ_OPEN) {
            ValueCallback<Uri[]> cb = fileCallback;
            fileCallback = null;
            if (cb == null) return;
            List<Uri> uris = new ArrayList<Uri>();
            if (result == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
                else if (data.getData() != null) uris.add(data.getData());
            }
            cb.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
        } else if (request == REQ_SAVE) {
            if (result == RESULT_OK && data != null && data.getData() != null) bridge.completeSave(data.getData());
            else bridge.cancelSave("cancelled");
        } else {
            super.onActivityResult(request, result, data);
        }
    }
}
