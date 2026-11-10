package aero.wolframlab;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * WolframLab Aero: ventana propia (WebView) sobre la web publicada.
 * El progreso se guarda en el almacenamiento local de esta app (localStorage / Cache Storage del WebView),
 * que persiste entre sesiones y entra en la copia de seguridad automática de Android.
 */
public class MainActivity extends Activity {
    static final String HOME = "https://miguelcoxcaballero.github.io/mathematica/";
    static final String HOST = "miguelcoxcaballero.github.io";
    static final int PICK_FILE = 7;

    WebView web;
    ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.WHITE);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage: aquí vive el progreso
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(s.getUserAgentString() + " WolframLabAeroApp/1.0");
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new Bridge(this), "WolframLabApp");
        web.setWebViewClient(new Client(this));
        web.setWebChromeClient(new Chrome(this));
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> download(url, disposition, mime));

        if (saved != null) {
            web.restoreState(saved);
        } else if (online()) {
            web.loadUrl(HOME);
        } else {
            showOffline();
        }
    }

    boolean online() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            NetworkInfo ni = cm == null ? null : cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (Exception e) {
            return true;
        }
    }

    void showOffline() {
        String html = "<!doctype html><html lang='es'><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fff;color:#222'>"
                + "<div style='text-align:center;padding:24px'><h2 style='font-weight:400;color:#dd1100'>Sin conexión</h2>"
                + "<p style='color:#666'>WolframLab Aero necesita internet para cargar las lecciones y el motor. Tu progreso sigue guardado en la app.</p>"
                + "<p><a href='" + HOME + "' style='display:inline-block;background:#dd1100;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none'>Reintentar</a></p></div></body></html>";
        web.loadDataWithBaseURL("https://offline.wolframlab.app/", html, "text/html", "utf-8", null);
    }





    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILE && fileCallback != null) {
            Uri[] out = null;
            if (result == RESULT_OK && data != null && data.getData() != null) {
                out = new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(out);
            fileCallback = null;
        }
    }

    /** Descargas (exportar progreso / CSV): la web genera blob: o data:, que se guardan en Descargas. */
    void download(String url, String disposition, String mime) {
        String name = "wolframlab-" + System.currentTimeMillis();
        if (disposition != null) {
            int k = disposition.indexOf("filename=");
            if (k >= 0) {
                name = disposition.substring(k + 9).replace("\"", "").trim();
            }
        }
        if (url.startsWith("blob:")) {
            String js = "(async()=>{try{const r=await fetch('" + url + "');const b=await r.blob();const fr=new FileReader();"
                    + "fr.onload=()=>WolframLabApp.save(String(fr.result),'" + name.replace("'", "") + "');fr.readAsDataURL(b);}"
                    + "catch(e){WolframLabApp.toast('No se pudo guardar el archivo');}})();";
            web.evaluateJavascript(js, null);
        } else if (url.startsWith("data:")) {
            new Bridge(this).save(url, name);
        } else {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (ActivityNotFoundException ignored) {
            }
        }
    }



    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) {
            web.saveState(out);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();   // asegura que el almacenamiento queda escrito en disco
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }
}

class Client extends WebViewClient {
    final MainActivity a;

    Client(MainActivity a) {
        this.a = a;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        Uri u = req.getUrl();
        String host = u.getHost() == null ? "" : u.getHost();
        if (MainActivity.HOST.equalsIgnoreCase(host) || "offline.wolframlab.app".equals(host)) {
            return false;                  // dentro de la app
        }
        try {
            a.startActivity(new Intent(Intent.ACTION_VIEW, u));   // enlaces externos: navegador
        } catch (ActivityNotFoundException ignored) {
        }
        return true;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
        if (req.isForMainFrame()) {
            a.showOffline();
        }
    }
}

class Chrome extends WebChromeClient {
    final MainActivity a;

    Chrome(MainActivity a) {
        this.a = a;
    }

    @Override
    public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams params) {
        if (a.fileCallback != null) {
            a.fileCallback.onReceiveValue(null);
        }
        a.fileCallback = cb;
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        try {
            a.startActivityForResult(Intent.createChooser(i, "Elegir archivo"), MainActivity.PICK_FILE);
        } catch (ActivityNotFoundException e) {
            a.fileCallback = null;
            return false;
        }
        return true;
    }
}

class Bridge {
    final MainActivity a;

    Bridge(MainActivity a) {
        this.a = a;
    }

    @JavascriptInterface
    public void toast(String msg) {
        a.runOnUiThread(() -> Toast.makeText(a, msg, Toast.LENGTH_LONG).show());
    }

    @JavascriptInterface
    public boolean isApp() {
        return true;
    }

    @JavascriptInterface
    public void save(String dataUrl, String name) {
        try {
            int comma = dataUrl.indexOf(',');
            String head = comma > 0 ? dataUrl.substring(0, comma) : "";
            String body = comma > 0 ? dataUrl.substring(comma + 1) : dataUrl;
            byte[] bytes = head.contains(";base64") ? Base64.decode(body, Base64.DEFAULT) : Uri.decode(body).getBytes("UTF-8");
            String mime = head.startsWith("data:") ? head.substring(5).split(";")[0] : "application/octet-stream";
            if (name == null || name.isEmpty() || !name.contains(".")) {
                name = (name == null || name.isEmpty() ? "wolframlab" : name) + (mime.contains("json") ? ".json" : mime.contains("csv") ? ".csv" : ".txt");
            }
            OutputStream os;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, mime.isEmpty() ? "application/octet-stream" : mime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = a.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                os = a.getContentResolver().openOutputStream(uri);
            } else {
                File dir = a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                os = new FileOutputStream(new File(dir, name));
            }
            os.write(bytes);
            os.close();
            toast("Guardado en Descargas: " + name);
        } catch (Exception e) {
            toast("No se pudo guardar el archivo");
        }
    }
}
