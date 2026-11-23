$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class CashKioskRawInputWindow : NativeWindow
{
    private const int WM_INPUT = 0x00FF;
    private const int WM_INPUT_DEVICE_CHANGE = 0x00FE;
    private const uint RID_INPUT = 0x10000003;
    private const uint RIDI_DEVICENAME = 0x20000007;
    private const uint RIM_TYPEKEYBOARD = 1;
    private const ushort RI_KEY_BREAK = 1;

    private readonly HashSet<int> pressedKeys = new HashSet<int>();

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTDEVICE
    {
        public ushort UsagePage;
        public ushort Usage;
        public uint Flags;
        public IntPtr Target;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTDEVICELIST
    {
        public IntPtr Device;
        public uint Type;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTHEADER
    {
        public uint Type;
        public uint Size;
        public IntPtr Device;
        public IntPtr WParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWKEYBOARD
    {
        public ushort MakeCode;
        public ushort Flags;
        public ushort Reserved;
        public ushort VKey;
        public uint Message;
        public uint ExtraInformation;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterRawInputDevices(
        RAWINPUTDEVICE[] devices, uint count, uint size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetRawInputDeviceList(
        IntPtr devices, ref uint count, uint size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetRawInputData(
        IntPtr rawInput, uint command, IntPtr data,
        ref uint size, uint headerSize);

    [DllImport("user32.dll", EntryPoint = "GetRawInputDeviceInfoW",
        CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetRawInputDeviceInfoW(
        IntPtr device, uint command, IntPtr data, ref uint size);

    public CashKioskRawInputWindow()
    {
        CreateHandle(new CreateParams());

        RAWINPUTDEVICE[] devices = new RAWINPUTDEVICE[1];
        devices[0].UsagePage = 1;
        devices[0].Usage = 6;
        devices[0].Flags = 0x00002100; // RIDEV_INPUTSINK | RIDEV_DEVNOTIFY
        devices[0].Target = Handle;

        bool registered = RegisterRawInputDevices(
            devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));

        if (!registered)
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                "RegisterRawInputDevices failed");

        EmitDeviceStatus("ready");
    }

    private static bool HasTargetDevice()
    {
        uint count = 0;
        uint itemSize = (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICELIST));
        uint result = GetRawInputDeviceList(IntPtr.Zero, ref count, itemSize);

        if (result == 0xFFFFFFFF || count == 0)
            return false;

        IntPtr buffer = Marshal.AllocHGlobal((int)(count * itemSize));
        try
        {
            result = GetRawInputDeviceList(buffer, ref count, itemSize);
            if (result == 0xFFFFFFFF)
                return false;

            for (int i = 0; i < count; i++)
            {
                IntPtr item = IntPtr.Add(buffer, i * (int)itemSize);
                RAWINPUTDEVICELIST device =
                    Marshal.PtrToStructure<RAWINPUTDEVICELIST>(item);

                if (device.Type != 1)
                    continue;

                string name = GetDeviceName(device.Device);
                if (name.IndexOf(
                    "VID_248A&PID_8367",
                    StringComparison.OrdinalIgnoreCase) >= 0)
                    return true;
            }
            return false;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void EmitDeviceStatus(string type)
    {
        Console.WriteLine(
            "{\"type\":\"" + type +
            "\",\"deviceFound\":" + (HasTargetDevice() ? "true" : "false") + "}");
        Console.Out.Flush();
    }

    private static string GetDeviceName(IntPtr device)
    {
        uint chars = 0;
        uint result = GetRawInputDeviceInfoW(
            device, RIDI_DEVICENAME, IntPtr.Zero, ref chars);

        if (result == 0xFFFFFFFF || chars == 0)
            return String.Empty;

        IntPtr buffer = Marshal.AllocHGlobal((int)(chars + 1) * 2);
        try
        {
            uint capacity = chars;
            result = GetRawInputDeviceInfoW(
                device, RIDI_DEVICENAME, buffer, ref capacity);

            if (result == 0xFFFFFFFF)
                return String.Empty;

            return Marshal.PtrToStringUni(buffer) ?? String.Empty;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string KeyForVirtualKey(int vk)
    {
        if (vk >= 96 && vk <= 105)
            return (vk - 96).ToString();

        switch (vk)
        {
            case 111: return "/"; // VK_DIVIDE
            case 109: return "-"; // VK_SUBTRACT
            case 107: return "+"; // VK_ADD
            case 106: return "*"; // VK_MULTIPLY
            default: return null;
        }
    }

    private static void Emit(string phase, int vk)
    {
        string key = KeyForVirtualKey(vk);
        if (key == null) return;

        Console.WriteLine(
            "{\"phase\":\"" + phase +
            "\",\"vk\":" + vk +
            ",\"key\":\"" + key +
            "\",\"deviceId\":\"VID_248A&PID_8367\"}");
        Console.Out.Flush();
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WM_INPUT_DEVICE_CHANGE)
        {
            EmitDeviceStatus("device");
        }

        if (message.Msg == WM_INPUT)
        {
            uint size = 0;
            uint headerSize = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));

            uint query = GetRawInputData(
                message.LParam, RID_INPUT, IntPtr.Zero,
                ref size, headerSize);

            if (query != 0xFFFFFFFF && size >= headerSize)
            {
                IntPtr buffer = Marshal.AllocHGlobal((int)size);
                try
                {
                    uint readSize = size;
                    uint read = GetRawInputData(
                        message.LParam, RID_INPUT, buffer,
                        ref readSize, headerSize);

                    if (read != 0xFFFFFFFF && read >= headerSize)
                    {
                        RAWINPUTHEADER header =
                            Marshal.PtrToStructure<RAWINPUTHEADER>(buffer);

                        if (header.Type == RIM_TYPEKEYBOARD)
                        {
                            string deviceName = GetDeviceName(header.Device);

                            if (deviceName.IndexOf(
                                "VID_248A&PID_8367",
                                StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                RAWKEYBOARD keyboard =
                                    Marshal.PtrToStructure<RAWKEYBOARD>(
                                        IntPtr.Add(buffer, (int)headerSize));

                                int vk = keyboard.VKey;
                                if (KeyForVirtualKey(vk) != null)
                                {
                                    bool keyUp = (keyboard.Flags & RI_KEY_BREAK) != 0;

                                    if (keyUp)
                                    {
                                        if (pressedKeys.Remove(vk))
                                            Emit("up", vk);
                                    }
                                    else if (pressedKeys.Add(vk))
                                    {
                                        Emit("down", vk);
                                    }
                                }
                            }
                        }
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
        }

        base.WndProc(ref message);
    }
}
'@

try {
    Add-Type -TypeDefinition $source -ReferencedAssemblies "System.Windows.Forms.dll"
    $window = New-Object CashKioskRawInputWindow
    [System.Windows.Forms.Application]::Run()
} catch {
    [Console]::Error.WriteLine($_.ToString())
    exit 1
}
