<#
    Prints the number of milliseconds since the last keyboard or mouse input,
    one value per line, until the parent process kills it.

    Uses the Win32 GetLastInputInfo API, which is session-wide: it reports real
    user input regardless of which application has focus.
#>
param(
    [int]$IntervalMs = 500
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class LastInput
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    public static uint IdleMilliseconds()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info))
        {
            return 0;
        }
        // Unsigned subtraction keeps working across the 49.7 day tick rollover.
        return GetTickCount() - info.dwTime;
    }
}
'@

while ($true) {
    [Console]::Out.WriteLine([LastInput]::IdleMilliseconds())
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds $IntervalMs
}
