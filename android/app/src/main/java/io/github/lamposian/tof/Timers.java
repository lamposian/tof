package io.github.lamposian.tof;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONObject;

import java.util.Iterator;

/**
 * Contact timers. The page keeps the timers on each contact; a copy lives here in SharedPreferences
 * so alarms can be set again after a restart and fire while Tof is closed.
 * Each entry: {at, title, text, open, done}. "open" is the contact to show when the notification is tapped.
 */
public class Timers extends BroadcastReceiver {
    static final String FIRE = "io.github.lamposian.tof.TIMER_FIRE";
    static final String SNOOZE = "io.github.lamposian.tof.TIMER_SNOOZE";
    static final String DONE = "io.github.lamposian.tof.TIMER_DONE";
    static final String CHANNEL = "timers";
    static final long SNOOZE_MS = 60 * 60 * 1000L;

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("timers", Context.MODE_PRIVATE); }

    static JSONObject all(Context c) {
        JSONObject out = new JSONObject();
        for (String id : prefs(c).getAll().keySet()) {
            try { out.put(id, new JSONObject(prefs(c).getString(id, "{}"))); } catch (Exception ignored) { }
        }
        return out;
    }

    static JSONObject get(Context c, String id) {
        try { String s = prefs(c).getString(id, null); return s == null ? null : new JSONObject(s); } catch (Exception e) { return null; }
    }

    static void put(Context c, String id, JSONObject t) { prefs(c).edit().putString(id, t.toString()).apply(); }

    static void set(Context c, String id, long at, String title, String text, String open) {
        try {
            JSONObject t = new JSONObject().put("at", at).put("title", title).put("text", text).put("open", open).put("done", false);
            put(c, id, t);
            schedule(c, id, at);
        } catch (Exception ignored) { }
    }

    static void cancel(Context c, String id) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        am.cancel(pending(c, FIRE, id));
        ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(id.hashCode());
        prefs(c).edit().remove(id).apply();
    }

    private static PendingIntent pending(Context c, String action, String id) {
        Intent i = new Intent(c, Timers.class).setAction(action).putExtra("id", id);
        int code = (action + id).hashCode();
        return PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static boolean exact(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        return Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
    }

    private static void schedule(Context c, String id, long at) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = pending(c, FIRE, id);
        long when = Math.max(at, System.currentTimeMillis() + 1000);
        // Exact when Android allows it; otherwise Android may deliver it a few minutes late.
        if (exact(c)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
    }

    /** After a restart or an app update every alarm is gone, so set the unfinished ones again. */
    static void rescheduleAll(Context c) {
        JSONObject a = all(c);
        for (Iterator<String> it = a.keys(); it.hasNext(); ) {
            String id = it.next();
            JSONObject t = a.optJSONObject(id);
            if (t != null && !t.optBoolean("done") && !t.optBoolean("fired")) schedule(c, id, t.optLong("at"));
        }
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Contact timers", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("When a timer you set on a contact ends");
        nm.createNotificationChannel(ch);
    }

    private static void show(Context c, String id, JSONObject t) {
        ensureChannel(c);
        Intent open = new Intent(c, MainActivity.class).setAction(Intent.ACTION_VIEW)
                .putExtra("openContact", t.optString("open")).putExtra("timer", id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(c, ("open" + id).hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_timer)
                .setContentTitle(t.optString("title"))
                .setContentText(t.optString("text"))
                .setStyle(new Notification.BigTextStyle().bigText(t.optString("text")))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .addAction(new Notification.Action.Builder(null, "Snooze 1 hour", pending(c, SNOOZE, id)).build())
                .addAction(new Notification.Action.Builder(null, "Done", pending(c, DONE, id)).build());
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        try {
            ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).notify(id.hashCode(), b.build());
        } catch (SecurityException ignored) { }
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            rescheduleAll(c);
            return;
        }
        String id = intent.getStringExtra("id");
        if (id == null) return;
        JSONObject t = get(c, id);
        if (t == null) return;
        try {
            if (FIRE.equals(action)) {
                if (t.optBoolean("done")) return;
                t.put("fired", true);
                put(c, id, t);
                show(c, id, t);
            } else if (SNOOZE.equals(action)) {
                long at = System.currentTimeMillis() + SNOOZE_MS;
                t.put("at", at).put("fired", false).put("snoozed", t.optInt("snoozed") + 1);
                put(c, id, t);
                ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(id.hashCode());
                schedule(c, id, at);
            } else if (DONE.equals(action)) {
                t.put("done", true).put("fired", true);
                put(c, id, t);
                ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(id.hashCode());
            }
        } catch (Exception ignored) { }
    }
}
