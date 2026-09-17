/**
 * Sends a raw byte buffer straight to an already-installed Windows printer's
 * spooler queue, as the RAW datatype — the same mechanism most POS software
 * uses to talk to a receipt printer (including, almost certainly, whatever
 * this shop's previous software used on this same BC-87AC).
 *
 * Deliberately not a native Node addon (no node-printer / escpos-usb here).
 * The printer is already installed as a normal Windows printer with a
 * working driver and USB connection — this file only needs to skip GDI/page
 * layout, not reimplement USB. Windows already exposes exactly that skip via
 * winspool.drv's WritePrinter with datatype "RAW", and PowerShell can reach
 * it directly through .NET P/Invoke with zero extra dependencies — no
 * node-gyp, no electron-rebuild step, nothing that can go out of ABI sync
 * with whatever Electron version this ships on (see package.json's
 * prepare-backend script for how much that already costs for better-sqlite3
 * alone).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAW_PRINTER_HELPER_CS = `
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static bool SendBytesToPrinter(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "Pure Milk POS Receipt";
    di.pDataType = "RAW";
    int written = 0;

    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
    try {
      if (!StartDocPrinter(hPrinter, 1, di)) return false;
      try {
        if (!StartPagePrinter(hPrinter)) return false;
        try {
          IntPtr pBytes = Marshal.AllocHGlobal(bytes.Length);
          try {
            Marshal.Copy(bytes, 0, pBytes, bytes.Length);
            return WritePrinter(hPrinter, pBytes, bytes.Length, out written) && written == bytes.Length;
          } finally {
            Marshal.FreeHGlobal(pBytes);
          }
        } finally {
          EndPagePrinter(hPrinter);
        }
      } finally {
        EndDocPrinter(hPrinter);
      }
    } finally {
      ClosePrinter(hPrinter);
    }
  }
}
`;

/**
 * @param {Buffer} buffer  Raw ESC/POS bytes to send as-is.
 * @param {string} printerName  Exact Windows printer name, as
 *   webContents.getPrintersAsync() reports it (see main.js's 'list-printers'
 *   handler) — must match precisely, spaces and all.
 */
function printRawBuffer(buffer, printerName) {
  return new Promise((resolve, reject) => {
    if (!printerName) {
      reject(new Error('No ESC/POS printer selected in Settings → Printer.'));
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pure-milk-escpos-'));
    const dataPath = path.join(tmpDir, 'receipt.bin');
    const cleanup = () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    };

    try {
      fs.writeFileSync(dataPath, buffer);
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }

    // Bytes and the printer name both travel as base64 inside the PowerShell
    // script text — the receipt can contain a customer's name/address in
    // whatever characters they typed, and the printer name can contain
    // spaces/punctuation; neither is safe to interpolate into a quoted
    // PowerShell string literal directly.
    const printerNameB64 = Buffer.from(printerName, 'utf16le').toString('base64');
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${RAW_PRINTER_HELPER_CS}
'@
$printerName = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${printerNameB64}'))
$bytes = [System.IO.File]::ReadAllBytes('${dataPath.replace(/\\/g, '\\\\')}')
$ok = [RawPrinterHelper]::SendBytesToPrinter($printerName, $bytes)
if (-not $ok) { throw "WritePrinter failed for '$printerName' (is it online and shared correctly?)" }
`;

    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    let stderr = '';
    ps.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    ps.on('error', (err) => { cleanup(); reject(err); });
    ps.on('close', (code) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `powershell exited with code ${code}`));
    });
  });
}

module.exports = { printRawBuffer };
