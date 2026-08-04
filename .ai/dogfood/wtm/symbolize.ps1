# msedge.dll 의 RVA 를 함수 이름으로 해석한다.
# cdb.exe 가 없으므로 Windows Kits 의 dbghelp.dll 을 직접 P/Invoke 한다.
# symsrv 가 심볼 서버에서 msedge.pdb 를 알아서 받아 캐시에 넣는다(대용량).
param(
  [string[]]$Rva = @('0x9db4ed','0x365b9d1','0x57489b','0x1c2b161','0x35bb213','0x35bb896','0xd0a53d','0x46f053','0x13ef3a0'),
  [string]$Image = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application\150.0.4078.105\msedge.dll',
  [string]$Cache = 'C:\symcache'
)

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Dbg {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr LoadLibrary(string path);

  [DllImport("dbghelp.dll", SetLastError=true)]
  public static extern uint SymSetOptions(uint opts);

  [DllImport("dbghelp.dll", CharSet=CharSet.Ansi, SetLastError=true)]
  public static extern bool SymInitialize(IntPtr h, string searchPath, bool invade);

  [DllImport("dbghelp.dll", CharSet=CharSet.Ansi, SetLastError=true)]
  public static extern ulong SymLoadModuleEx(IntPtr h, IntPtr file, string imageName,
      string moduleName, ulong baseAddr, uint dllSize, IntPtr data, uint flags);

  [DllImport("dbghelp.dll", CharSet=CharSet.Ansi, SetLastError=true)]
  public static extern bool SymFromAddr(IntPtr h, ulong addr, out ulong disp, IntPtr sym);

  // SYMBOL_INFO: 88바이트 헤더 + 가변 이름 버퍼
  public static string Resolve(IntPtr h, ulong addr) {
    int hdr = 88, max = 1024;
    IntPtr buf = Marshal.AllocHGlobal(hdr + max);
    try {
      for (int i = 0; i < hdr + max; i++) Marshal.WriteByte(buf, i, 0);
      Marshal.WriteInt32(buf, 0, hdr);        // SizeOfStruct
      Marshal.WriteInt32(buf, 80, max);       // MaxNameLen (오프셋 80, Name 은 84)
      ulong disp;
      if (!SymFromAddr(h, addr, out disp, buf)) return "<no symbol: " + Marshal.GetLastWin32Error() + ">";
      string name = Marshal.PtrToStringAnsi(new IntPtr(buf.ToInt64() + 84));
      return name + "+0x" + disp.ToString("x");
    } finally { Marshal.FreeHGlobal(buf); }
  }
}
'@

Add-Type -TypeDefinition $src -Language CSharp | Out-Null

$kits = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64'
foreach ($d in @('symsrv.dll','dbgcore.dll','dbghelp.dll')) {
  $h = [Dbg]::LoadLibrary((Join-Path $kits $d))
  if ($h -eq [IntPtr]::Zero) { Write-Host "LoadLibrary failed: $d"; exit 1 }
}

New-Item -ItemType Directory -Force $Cache | Out-Null
$searchPath = "SRV*$Cache*https://msdl.microsoft.com/download/symbols"

# SYMOPT_UNDNAME(0x2) | SYMOPT_LOAD_LINES(0x10) | SYMOPT_FAIL_CRITICAL_ERRORS(0x200)
[Dbg]::SymSetOptions(0x2 -bor 0x10 -bor 0x200) | Out-Null

$hProc = [System.Diagnostics.Process]::GetCurrentProcess().Handle
if (-not [Dbg]::SymInitialize($hProc, $searchPath, $false)) { Write-Host "SymInitialize failed"; exit 1 }

$size = (Get-Item $Image).Length
$base = [uint64]0x180000000
Write-Host "loading symbols for $Image (this downloads msedge.pdb, ~GB) ..."
$got = [Dbg]::SymLoadModuleEx($hProc, [IntPtr]::Zero, $Image, "msedge", $base, [uint32]$size, [IntPtr]::Zero, 0)
if ($got -eq 0) { Write-Host "SymLoadModuleEx failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)"; exit 1 }
Write-Host "module loaded at 0x$($got.ToString('x'))"

foreach ($r in $Rva) {
  $off = [Convert]::ToUInt64($r.Replace('0x',''), 16)
  Write-Host ("{0,-12} => {1}" -f $r, [Dbg]::Resolve($hProc, $base + $off))
}
