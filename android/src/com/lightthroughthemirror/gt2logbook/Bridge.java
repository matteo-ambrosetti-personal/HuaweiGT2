package com.lightthroughthemirror.gt2logbook;

import android.net.Uri;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.regex.Pattern;

/**
 * window.GT2Native: how the page saves an export (src/app/downloads.js).
 *
 * A WebView cannot download a blob: URL, so the page hands the bytes over in
 * base64 chunks: begin(id, name, mime), append(id, chunk)…, finish(id). They
 * are spooled to a file in the app's cache, the system "Save to" dialog asks
 * where the file goes, and the page hears back through
 * window.GT2NativeSaved(id, 'ok' | 'cancelled' | 'busy' | 'error').
 *
 * One save at a time, like a browser's download prompt. The bridge exists only
 * in this app's own WebView, which never shows any page but the bundled one.
 */
final class Bridge {
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

    private final MainActivity activity;
    private final File dir;

    // the save being received or waiting for its dialog; guarded by `this`
    private String id;
    private String name;
    private String mime;
    private File file;
    private OutputStream out;
    private boolean failed;
    private boolean asking;

    Bridge(MainActivity activity) {
        this.activity = activity;
        this.dir = new File(activity.getCacheDir(), "exports");
    }

    /** Spooled exports a closed app never handed over. */
    void clearLeftovers() {
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
    }

    @JavascriptInterface
    public synchronized void begin(String id, String name, String mime) {
        if (id == null || !ID.matcher(id).matches()) return;
        if (this.id != null) {
            activity.reportSaved(id, "busy");
            return;
        }
        this.id = id;
        this.name = name == null || name.isEmpty() ? "export" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
        this.mime = mime == null || !mime.contains("/") ? "application/octet-stream" : mime;
        this.failed = false;
        this.asking = false;
        try {
            dir.mkdirs();
            file = new File(dir, id);
            out = new FileOutputStream(file);
        } catch (IOException e) {
            failed = true;
        }
    }

    @JavascriptInterface
    public synchronized void append(String id, String base64) {
        if (!same(id) || failed || out == null) return;
        try {
            out.write(Base64.decode(base64, Base64.DEFAULT));
        } catch (IOException | IllegalArgumentException e) {
            failed = true;
        }
    }

    @JavascriptInterface
    public synchronized void finish(String id) {
        if (!same(id)) return;
        closeQuietly(out);
        out = null;
        if (failed) {
            end("error");
            return;
        }
        asking = true;
        final String n = name, m = mime;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.askWhereToSave(n, m);
            }
        });
    }

    /** The person chose where to save: copy the spooled file there, off the UI thread. */
    void completeSave(final Uri target) {
        final File src;
        synchronized (this) {
            if (!asking || file == null) return;
            src = file;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                String result = "ok";
                InputStream in = null;
                OutputStream dst = null;
                try {
                    in = new FileInputStream(src);
                    dst = activity.getContentResolver().openOutputStream(target, "w");
                    if (dst == null) throw new IOException("no output stream");
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) dst.write(buf, 0, n);
                    dst.flush();
                } catch (IOException | SecurityException e) {
                    result = "error";
                } finally {
                    closeQuietly(in);
                    closeQuietly(dst);
                }
                synchronized (Bridge.this) {
                    end(result);
                }
            }
        }, "gt2-save").start();
    }

    synchronized void cancelSave(String result) {
        if (id != null) end(result);
    }

    private boolean same(String id) {
        return this.id != null && this.id.equals(id);
    }

    /** Report and forget the current save (caller holds the lock). */
    private void end(String result) {
        String done = id;
        closeQuietly(out);
        if (file != null) file.delete();
        id = null;
        name = null;
        mime = null;
        file = null;
        out = null;
        failed = false;
        asking = false;
        if (done != null) activity.reportSaved(done, result);
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
            // nothing left to do with it
        }
    }
}
