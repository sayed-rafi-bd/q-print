package jp.co.keex.qprint

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Process

/**
 * Keeps the app alive while it is in the background, and is how the user gets back to it.
 *
 * A notification on its own does not keep an app alive. Android freezes an app that has been put
 * away and then kills it, and a notification whose buttons lead nowhere is worse than no
 * notification at all. A foreground service is the mechanism the platform provides for exactly this,
 * and this is what makes the notification a real way back in.
 *
 * The service holds no state and does no work of its own. It exists to keep the process alive and to
 * own the notification, which [MainActivity] starts and stops as the app moves between the front and
 * the background.
 *
 * The notification and its two buttons are built here rather than from the Rust side, because a
 * foreground service's notification has to be the one the service itself posts. A second notification
 * raised from Rust would sit beside this one rather than being it.
 */
class BackgroundService : Service() {

  /**
   * The Exit button, which ends the app rather than opening it.
   *
   * A broadcast rather than an activity, so the app does not flash open on its way out. It is
   * registered at runtime rather than declared in the manifest because Android 12+ stopped delivering
   * manifest-registered broadcasts to an app in the background, which is the only state this app is
   * ever in when the button is pressed.
   */
  private inner class ExitReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
      // Stop first: this takes the notification away, and stops Android restarting the service
      // behind a process that is about to die.
      context.stopService(Intent(context, BackgroundService::class.java))
      stopSelf()
      // Killing the process is the only real exit available from here, and it needs nothing from the
      // activity: with the process gone, Android drops the task from the recents list by itself.
      Process.killProcess(Process.myPid())
    }
  }

  private var receiver: ExitReceiver? = null

  companion object {
    private const val CHANNEL_ID = "background"
    private const val NOTIFICATION_ID = 1001

    /** The broadcast the Exit button sends. Only ever received by this app. */
    private const val ACTION_EXIT = "jp.co.keex.qprint.EXIT"

    private const val REQUEST_OPEN = 1
    private const val REQUEST_EXIT = 2

    /** Starts the service and puts the notification up. Safe to call repeatedly. */
    fun start(context: Context) {
      val intent = Intent(context, BackgroundService::class.java)
      // Android 8+ refuses to start a background service from the background. `startForegroundService`
      // is the form the platform allows there, and it obliges us to call `startForeground` within a
      // few seconds, which `onStartCommand` does.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    /** Takes the notification down and lets the process be killed again. */
    fun stop(context: Context) {
      context.stopService(Intent(context, BackgroundService::class.java))
    }

    /** Asks for permission to post notifications. Android 13 (API 33) turned this into a runtime grant. */
    fun requestPermission(activity: MainActivity) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
      val granted = activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED
      if (!granted) {
        activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1002)
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannel()
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // Android 10+ requires the service type to be restated where the service is promoted, matching
      // the one in the manifest.
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    registerExitReceiver()
    // `START_NOT_STICKY`: if Android kills this anyway, do not come back on our own. Restarting
    // silently would mean a service reappearing with no explanation and nothing to see it by. The
    // user can reopen the app, which is what the Open button is for.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    val registered = receiver
    if (registered != null) {
      try {
        unregisterReceiver(registered)
      } catch (_: IllegalArgumentException) {
        // Already gone, which is the normal case when Android tears the service down.
      }
      receiver = null
    }
    super.onDestroy()
  }

  private fun registerExitReceiver() {
    if (receiver != null) return
    val r = ExitReceiver()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      // Android 13+ requires the exported/not-exported flag to be stated. This one only ever gets
      // this app's own broadcast, so it is not exported.
      registerReceiver(r, IntentFilter(ACTION_EXIT), Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(r, IntentFilter(ACTION_EXIT))
    }
    receiver = r
  }

  /** Tapping the notification, or its Open button, brings the existing activity forward. */
  private fun openIntent(): PendingIntent {
    val intent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
    }
    return PendingIntent.getActivity(
      this,
      REQUEST_OPEN,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** The Exit button, as a broadcast rather than an activity, so the app does not flash open first. */
  private fun exitIntent(): PendingIntent {
    val intent = Intent(ACTION_EXIT).setPackage(packageName)
    return PendingIntent.getBroadcast(
      this,
      REQUEST_EXIT,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun buildNotification(): Notification {
    // A single pending intent instance reused for the body and the Open button, so the two cannot
    // disagree and a rebuild cannot be recognised as a different intent.
    val open = openIntent()
    val exit = exitIntent()
    val icon = android.R.drawable.ic_menu_view

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    return builder
      .setContentTitle(getString(R.string.app_name))
      .setContentText("Running in the background.")
      .setSmallIcon(icon)
      .setContentIntent(open)
      // Ongoing, because a background app that can be swiped away is not really running.
      .setOngoing(true)
      // Tapping the body opens the app, which is what the Open button does, so it is not left to
      // show as an action as well.
      .setAutoCancel(true)
      .addAction(Notification.Action.Builder(icon, "Open", open).build())
      .addAction(Notification.Action.Builder(icon, "Exit", exit).build())
      .build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Running in the background",
      // LOW, so it neither buzzes nor heads-up over anything: a status line that should simply be
      // there, not something that interrupts.
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shown while Q-Print is in the background."
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }
}