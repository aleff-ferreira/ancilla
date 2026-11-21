# READ-ONLY. Prints one JSON line with the master volume, dB level and mute flag of the default render endpoint, the default
# communications render endpoint and the default capture endpoint (IAudioEndpointVolume getters). driver.mjs runs it before
# anything is played, because a muted speaker makes every echo number meaningless. The interface lists every method in the
# documented vtable order (endpointvolume.h) so that the slots line up; the setters are declared and never called.
$code = @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorComObject2 {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator2 {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice2 device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice2 device);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice2 {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr props);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out int state);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid context);          // declared for the vtable, never called
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);      // declared for the vtable, never called
  [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid context);        // never called
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);    // never called
  [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);        // never called
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
  [PreserveSig] int VolumeStepUp(ref Guid context);                                              // never called
  [PreserveSig] int VolumeStepDown(ref Guid context);                                            // never called
  [PreserveSig] int QueryHardwareSupport(out uint mask);
  [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
}
public static class EndpointVolumeReader {
  static string One(int dataFlow, int role) {
    try {
      var en = (IMMDeviceEnumerator2)new MMDeviceEnumeratorComObject2();
      IMMDevice2 dev; int hr = en.GetDefaultAudioEndpoint(dataFlow, role, out dev);
      if (hr != 0) return "{\"error\":\"no endpoint hr=" + hr + "\"}";
      string id; dev.GetId(out id);
      Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o;
      hr = dev.Activate(ref iid, 23, IntPtr.Zero, out o);
      if (hr != 0) return "{\"id\":\"" + id + "\",\"error\":\"activate hr=" + hr + "\"}";
      var v = (IAudioEndpointVolume)o;
      float scalar, db; bool mute;
      v.GetMasterVolumeLevelScalar(out scalar); v.GetMasterVolumeLevel(out db); v.GetMute(out mute);
      return "{\"id\":\"" + id + "\",\"volume\":" + scalar.ToString("0.###", CultureInfo.InvariantCulture) + ",\"db\":" + db.ToString("0.#", CultureInfo.InvariantCulture) + ",\"muted\":" + (mute ? "true" : "false") + "}";
    } catch (Exception e) {
      return "{\"error\":\"" + e.Message.Replace("\"", "'") + "\"}";
    }
  }
  public static string ReadAll() {
    return "{\"render\":" + One(0, 0) + ",\"communications\":" + One(0, 2) + ",\"capture\":" + One(1, 0) + "}";
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[EndpointVolumeReader]::ReadAll()
