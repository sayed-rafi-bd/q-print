package com.example.printtest.print

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.ParcelFileDescriptor
import android.print.PrintAttributes
import android.print.PrintManager
import android.util.Base64
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.Inet4Address
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@InvokeArg
class PrintArgs {
    lateinit var path: String
    var jobName: String = "Labels"
}

@InvokeArg
class RenderArgs {
    lateinit var path: String
    var dpi: Int = 203
}

/** `id` is a Bluetooth MAC address or a USB "vendorId:productId" (hex); `data` is Base64. */
@InvokeArg
class SendArgs {
    lateinit var id: String
    lateinit var data: String
}

@TauriPlugin(
    permissions = [
        // Android 12+ asks for this at runtime. Older versions use the install-time BLUETOOTH permission.
        Permission(strings = [Manifest.permission.BLUETOOTH_CONNECT], alias = "bluetooth")
    ]
)
class PrintPlugin(private val activity: Activity) : Plugin(activity) {

    /** Page count and first-page size (PDF points, 1/72 inch) of the PDF. */
    private class PdfInfo(val pages: Int, val widthPt: Int, val heightPt: Int)

    private fun readPdfInfo(file: File): PdfInfo {
        val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        val renderer = PdfRenderer(fd)
        try {
            val page = renderer.openPage(0)
            try {
                return PdfInfo(renderer.pageCount, page.width, page.height)
            } finally {
                page.close()
            }
        } finally {
            renderer.close()
            fd.close()
        }
    }

    /**
     * Opens the system print dialog for a PDF file. Resolves as soon as the dialog is requested
     * (not when the job has printed), with the page count and the paper size that was requested.
     */
    @Command
    fun printPdf(invoke: Invoke) {
        val args = invoke.parseArgs(PrintArgs::class.java)
        val file = File(args.path)
        if (!file.exists()) {
            invoke.reject("PDF file not found: ${args.path}")
            return
        }

        val info = try {
            readPdfInfo(file)
        } catch (e: Exception) {
            file.delete()
            invoke.reject("Could not read the PDF: ${e.message}")
            return
        }

        // PDF points -> mils (1/1000 inch), which is what PrintAttributes.MediaSize uses.
        val widthMils = (info.widthPt / 72.0 * 1000).toInt()
        val heightMils = (info.heightPt / 72.0 * 1000).toInt()

        activity.runOnUiThread {
            try {
                val pm = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
                // MediaSize is defined portrait; ask for landscape explicitly when the page is wide.
                val portrait = PrintAttributes.MediaSize(
                    "label_${info.widthPt}x${info.heightPt}",
                    "Label",
                    minOf(widthMils, heightMils),
                    maxOf(widthMils, heightMils)
                )
                val media = if (widthMils > heightMils) portrait.asLandscape() else portrait
                val attrs = PrintAttributes.Builder()
                    .setMediaSize(media)
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build()

                pm.print(args.jobName, PdfFileAdapter(file, args.jobName, info.pages), attrs)

                val reply = JSObject()
                reply.put("pages", info.pages)
                reply.put("widthMm", info.widthPt / 72.0 * 25.4)
                reply.put("heightMm", info.heightPt / 72.0 * 25.4)
                invoke.resolve(reply)
            } catch (e: Exception) {
                file.delete()
                invoke.reject("Could not open the print dialog: ${e.message}")
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // PDF -> 1-bit bitmaps (for printers that take ZPL / TSPL / ESC-POS / CPCL / PWG raster)
    // -----------------------------------------------------------------------------------------

    /**
     * Renders every page of the PDF at `dpi` and returns, per page, `width`, `height` (pixels) and
     * `data`: Base64 of the 1-bit image, rows packed MSB first, a set bit is a black dot.
     */
    @Command
    fun renderPdf(invoke: Invoke) {
        val args = invoke.parseArgs(RenderArgs::class.java)
        Thread {
            try {
                val dpi = args.dpi.coerceIn(72, 1200)
                val fd = ParcelFileDescriptor.open(File(args.path), ParcelFileDescriptor.MODE_READ_ONLY)
                val renderer = PdfRenderer(fd)
                val pages = JSArray()
                try {
                    for (i in 0 until renderer.pageCount) {
                        val page = renderer.openPage(i)
                        val w = maxOf(1, Math.round(page.width / 72.0 * dpi).toInt())
                        val h = maxOf(1, Math.round(page.height / 72.0 * dpi).toInt())
                        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        try {
                            bmp.eraseColor(Color.WHITE)
                            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_PRINT)
                        } finally {
                            page.close()
                        }
                        val packed = packBlackWhite(bmp)
                        bmp.recycle()
                        val o = JSObject()
                        o.put("width", w)
                        o.put("height", h)
                        o.put("data", Base64.encodeToString(packed, Base64.NO_WRAP))
                        pages.put(o)
                    }
                } finally {
                    renderer.close()
                    fd.close()
                }
                val reply = JSObject()
                reply.put("pages", pages)
                invoke.resolve(reply)
            } catch (e: Throwable) {
                invoke.reject("Could not render the PDF: ${e.message}")
            }
        }.start()
    }

    /** Threshold to black/white and pack 8 pixels per byte (MSB first, 1 = black). */
    private fun packBlackWhite(bmp: Bitmap): ByteArray {
        val w = bmp.width
        val h = bmp.height
        val stride = (w + 7) / 8
        val out = ByteArray(stride * h)
        val row = IntArray(w)
        for (y in 0 until h) {
            bmp.getPixels(row, 0, w, 0, y, w, 1)
            for (x in 0 until w) {
                val c = row[x]
                // Light grey anti-aliasing counts as black so thin barcode bars and small text survive.
                val lum = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000
                if (lum < 160) {
                    out[y * stride + x / 8] = (out[y * stride + x / 8].toInt() or (0x80 shr (x % 8))).toByte()
                }
            }
        }
        return out
    }

    // -----------------------------------------------------------------------------------------
    // Wi-Fi / LAN discovery (mDNS / DNS-SD)
    // -----------------------------------------------------------------------------------------

    /**
     * Looks for printers on the local network for a few seconds. Returns `printers`: each has
     * `name`, `kind` ("ipp" or "raw"), `host`, `port` and `path` (IPP resource path).
     */
    @Command
    fun discoverPrinters(invoke: Invoke) {
        Thread {
            val nsd = activity.getSystemService(Context.NSD_SERVICE) as? NsdManager
            if (nsd == null) {
                invoke.reject("This device has no network service discovery.")
                return@Thread
            }
            val types = listOf("_ipp._tcp" to "ipp", "_pdl-datastream._tcp" to "raw")
            val seen = ConcurrentLinkedQueue<Pair<NsdServiceInfo, String>>()
            val listeners = ArrayList<NsdManager.DiscoveryListener>()
            try {
                for ((type, kind) in types) {
                    val l = object : NsdManager.DiscoveryListener {
                        override fun onDiscoveryStarted(serviceType: String) {}
                        override fun onDiscoveryStopped(serviceType: String) {}
                        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
                        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
                        override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
                        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                            seen.add(serviceInfo to kind)
                        }
                    }
                    listeners.add(l)
                    nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l)
                }
                Thread.sleep(4000)
            } catch (e: Throwable) {
                invoke.reject("Printer discovery failed: ${e.message}")
                return@Thread
            } finally {
                listeners.forEach { try { nsd.stopServiceDiscovery(it) } catch (ignored: Throwable) {} }
            }

            // NsdManager resolves one service at a time, so go through them in turn.
            val printers = JSArray()
            val done = HashSet<String>()
            for ((info, kind) in seen) {
                if (!done.add(info.serviceName + "/" + kind)) continue
                val latch = CountDownLatch(1)
                var resolved: NsdServiceInfo? = null
                try {
                    @Suppress("DEPRECATION")
                    nsd.resolveService(info, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { latch.countDown() }
                        override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                            resolved = serviceInfo
                            latch.countDown()
                        }
                    })
                } catch (ignored: Throwable) {
                    continue
                }
                latch.await(3, TimeUnit.SECONDS)
                val r = resolved ?: continue
                @Suppress("DEPRECATION")
                val addr = r.host ?: continue
                // Prefer IPv4: a link-local IPv6 address needs a scope id the printer URL cannot carry.
                val host = (addr as? Inet4Address)?.hostAddress ?: addr.hostAddress?.substringBefore('%') ?: continue
                val rp = r.attributes?.get("rp")?.let { String(it, Charsets.UTF_8).trim('/') } ?: ""
                val o = JSObject()
                o.put("name", r.serviceName)
                o.put("kind", kind)
                o.put("host", host)
                o.put("port", r.port)
                o.put("path", if (kind == "ipp") "/" + (if (rp.isEmpty()) "ipp/print" else rp) else "")
                printers.put(o)
            }
            val reply = JSObject()
            reply.put("printers", printers)
            invoke.resolve(reply)
        }.start()
    }

    // -----------------------------------------------------------------------------------------
    // Bluetooth (classic, Serial Port Profile)
    // -----------------------------------------------------------------------------------------

    private fun bluetoothAdapter(): BluetoothAdapter? =
        (activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    /** Runs `block` once the Bluetooth permission is available (asking the user on Android 12+). */
    private fun withBluetooth(invoke: Invoke, block: (Invoke) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || getPermissionState("bluetooth") == PermissionState.GRANTED) {
            block(invoke)
        } else {
            requestPermissionForAlias("bluetooth", invoke, "bluetoothPermissionResult")
        }
    }

    @PermissionCallback
    fun bluetoothPermissionResult(invoke: Invoke) {
        if (getPermissionState("bluetooth") == PermissionState.GRANTED) {
            when (invoke.command) {
                "listBluetooth" -> doListBluetooth(invoke)
                "sendBluetooth" -> doSendBluetooth(invoke)
                else -> invoke.reject("Unexpected Bluetooth request.")
            }
        } else {
            invoke.reject("Bluetooth permission was denied. Allow \"Nearby devices\" for this app in the Android settings.")
        }
    }

    /** Paired Bluetooth devices as `devices`: `name`, `address`. The printer must be paired in Android settings first. */
    @Command
    fun listBluetooth(invoke: Invoke) = withBluetooth(invoke) { doListBluetooth(it) }

    private fun doListBluetooth(invoke: Invoke) {
        try {
            val adapter = bluetoothAdapter()
            if (adapter == null) {
                invoke.reject("This device has no Bluetooth.")
                return
            }
            if (!adapter.isEnabled) {
                invoke.reject("Bluetooth is off. Turn it on and pair the printer in the Android settings.")
                return
            }
            val devices = JSArray()
            for (d in adapter.bondedDevices) {
                val o = JSObject()
                o.put("name", d.name ?: d.address)
                o.put("address", d.address)
                devices.put(o)
            }
            val reply = JSObject()
            reply.put("devices", devices)
            invoke.resolve(reply)
        } catch (e: SecurityException) {
            invoke.reject("Bluetooth permission is missing: ${e.message}")
        }
    }

    @Command
    fun sendBluetooth(invoke: Invoke) = withBluetooth(invoke) { doSendBluetooth(it) }

    private fun doSendBluetooth(invoke: Invoke) {
        val args = invoke.parseArgs(SendArgs::class.java)
        Thread {
            var socket: BluetoothSocket? = null
            try {
                val adapter = bluetoothAdapter()
                if (adapter == null || !adapter.isEnabled) {
                    invoke.reject("Bluetooth is off. Turn it on and try again.")
                    return@Thread
                }
                val data = Base64.decode(args.data, Base64.DEFAULT)
                val device: BluetoothDevice = adapter.getRemoteDevice(args.id)
                try { adapter.cancelDiscovery() } catch (ignored: SecurityException) {}
                socket = openRfcomm(device)
                val out = socket.outputStream
                var off = 0
                while (off < data.size) {
                    val n = minOf(512, data.size - off)
                    out.write(data, off, n)
                    off += n
                }
                out.flush()
                // Closing right away can drop what the printer has not read yet.
                Thread.sleep(500L + data.size / 2000)
                invoke.resolve()
            } catch (e: SecurityException) {
                invoke.reject("Bluetooth permission is missing: ${e.message}")
            } catch (e: Exception) {
                invoke.reject(
                    "Could not print over Bluetooth: ${e.message}. Check that the printer is on, in range, " +
                        "paired in the Android settings, and not connected to another phone."
                )
            } finally {
                try { socket?.close() } catch (ignored: Exception) {}
            }
        }.start()
    }

    private val sppUuid: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    private fun openRfcomm(device: BluetoothDevice): BluetoothSocket {
        try {
            val s = device.createRfcommSocketToServiceRecord(sppUuid)
            s.connect()
            return s
        } catch (first: Exception) {
            // Some cheap printers do not publish the SPP record; connecting to channel 1 directly works for them.
            try {
                val m = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                val s = m.invoke(device, 1) as BluetoothSocket
                s.connect()
                return s
            } catch (ignored: Exception) {
                throw first
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // USB (OTG cable, bulk transfer to the printer's OUT endpoint)
    // -----------------------------------------------------------------------------------------

    private fun usbManager() = activity.getSystemService(Context.USB_SERVICE) as UsbManager

    private fun usbId(d: UsbDevice) = String.format("%04x:%04x", d.vendorId, d.productId)

    /** The interface to print through: printer class (7) or vendor specific (255) with a bulk OUT endpoint. */
    private fun printerInterface(d: UsbDevice): Pair<UsbInterface, UsbEndpoint>? {
        for (i in 0 until d.interfaceCount) {
            val intf = d.getInterface(i)
            if (intf.interfaceClass != UsbConstants.USB_CLASS_PRINTER && intf.interfaceClass != UsbConstants.USB_CLASS_VENDOR_SPEC) continue
            for (e in 0 until intf.endpointCount) {
                val ep = intf.getEndpoint(e)
                if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_OUT) return intf to ep
            }
        }
        return null
    }

    /** USB devices that look like printers, as `devices`: `name`, `id` ("vendorId:productId" in hex). */
    @Command
    fun listUsb(invoke: Invoke) {
        val devices = JSArray()
        for (d in usbManager().deviceList.values) {
            if (printerInterface(d) == null) continue
            val o = JSObject()
            val name = try { d.productName } catch (ignored: SecurityException) { null }
            o.put("name", (name ?: "USB printer") + " (" + usbId(d) + ")")
            o.put("id", usbId(d))
            devices.put(o)
        }
        val reply = JSObject()
        reply.put("devices", devices)
        invoke.resolve(reply)
    }

    @Command
    fun sendUsb(invoke: Invoke) {
        val args = invoke.parseArgs(SendArgs::class.java)
        val manager = usbManager()
        val device = manager.deviceList.values.firstOrNull { usbId(it) == args.id.lowercase() }
        if (device == null) {
            invoke.reject("The USB printer ${args.id} is not connected. Plug it in with an OTG cable.")
            return
        }
        val data = Base64.decode(args.data, Base64.DEFAULT)
        if (manager.hasPermission(device)) {
            writeUsb(manager, device, data, invoke)
            return
        }

        // Ask the user once ("Allow the app to access the USB device?"), then continue in the receiver.
        val action = "com.example.printtest.USB_PERMISSION"
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                try { activity.unregisterReceiver(this) } catch (ignored: Exception) {}
                if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                    writeUsb(manager, device, data, invoke)
                } else {
                    invoke.reject("USB permission was denied. Print again and tap OK when Android asks.")
                }
            }
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val pending = PendingIntent.getBroadcast(activity, 0, Intent(action).setPackage(activity.packageName), flags)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            activity.registerReceiver(receiver, IntentFilter(action))
        }
        manager.requestPermission(device, pending)
    }

    private fun writeUsb(manager: UsbManager, device: UsbDevice, data: ByteArray, invoke: Invoke) {
        Thread {
            var connection: android.hardware.usb.UsbDeviceConnection? = null
            var intf: UsbInterface? = null
            try {
                val (iface, ep) = printerInterface(device) ?: throw IllegalStateException("no printer interface found")
                intf = iface
                connection = manager.openDevice(device) ?: throw IllegalStateException("could not open the device")
                if (!connection.claimInterface(iface, true)) throw IllegalStateException("another app is using the printer")
                var off = 0
                while (off < data.size) {
                    val n = minOf(16384, data.size - off)
                    val chunk = if (off == 0 && n == data.size) data else data.copyOfRange(off, off + n)
                    val written = connection.bulkTransfer(ep, chunk, chunk.size, 10000)
                    if (written < 0) throw IllegalStateException("the printer stopped accepting data")
                    off += written
                }
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject("Could not print over USB: ${e.message}")
            } finally {
                try { if (intf != null) connection?.releaseInterface(intf) } catch (ignored: Exception) {}
                try { connection?.close() } catch (ignored: Exception) {}
            }
        }.start()
    }
}
