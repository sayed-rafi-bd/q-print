package com.example.printtest.print

import android.app.Activity
import android.content.Context
import android.os.ParcelFileDescriptor
import android.print.PrintAttributes
import android.print.PrintManager
import android.graphics.pdf.PdfRenderer
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class PrintArgs {
    lateinit var path: String
    var jobName: String = "Labels"
}

@TauriPlugin
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
}
