package io.github.lamposian.tof;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** Every web link Tof opens goes through here, so they all open the private way. */
final class Browse {
    private Browse() { }

    /**
     * Opens a link in Chrome without history or cookies: an ephemeral Custom Tab, plus the
     * Incognito extra that Chrome honours where it allows it. Other links (tel:, mailto:) open normally.
     */
    static void open(Context c, Uri url) {
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase();
        Intent i = new Intent(Intent.ACTION_VIEW, url);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (scheme.equals("https") || scheme.equals("http")) {
            Bundle b = new Bundle();
            b.putBinder("android.support.customtabs.extra.SESSION", null);
            i.putExtras(b);
            i.putExtra("androidx.browser.customtabs.extra.ENABLE_EPHEMERAL_BROWSING", true);
            i.putExtra("com.google.android.apps.chrome.EXTRA_OPEN_NEW_INCOGNITO_TAB", true);
            i.setPackage("com.android.chrome");
        }
        try {
            c.startActivity(i);
        } catch (ActivityNotFoundException e) {
            i.setPackage(null);
            try { c.startActivity(i); } catch (ActivityNotFoundException ignored) { }
        }
    }
}
