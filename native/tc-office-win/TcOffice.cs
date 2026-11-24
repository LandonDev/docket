// tc-office: TempCode's Office helper on Windows (docs/agents/work-office.md "Windows").
//
// Drives the Excel, Word, PowerPoint and classic Outlook the owner has open, by COM, in his own
// session. Spoken to by TempCode over stdin and stdout, one JSON object per line:
//   in:  {"id":1,"verb":"readRange","args":{...}}
//   out: {"id":1,"ok":true,"value":...}  or  {"id":1,"ok":false,"error":{"code":"busy","message":"...","hresult":"0x80010001"}}
//   out: {"event":"ready","version":1}  once, and {"event":"changed","book":...,"sheet":...,"address":"B2:C3"} from Excel
// It never starts an app unseen (save `open`, the switch), never sends on its own, and exits when
// its stdin closes. `serve --listen 127.0.0.1:PORT --token-file FILE` speaks the same frames on a
// loopback door instead (the box's Windows VM), and there it also reads OneDrive's folders (Guest). Every COM call goes through ICom, so the tests run it against a recorded
// surface (RecordedCom.cs, compiled in with /define:RECORDED) where Office is not installed.
//
// Built by the csc.exe every Windows carries (.NET Framework 4), so C# 5: no string
// interpolation, no `?.`, no exception filters.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TcOffice {

// A refusal in words, with the code TempCode's OfficeError carries.
public class Refusal : Exception {
  public readonly string Code;
  public Refusal(string code, string message) : base(message) { Code = code; }
}

// The COM surface: the real one by IDispatch, a recorded one in tests.
public interface ICom {
  bool Registered(string progId);
  bool Running(string processName);
  // The running instance; MK_E_UNAVAILABLE (0x800401E3) when none is.
  object Active(string progId);
  object Get(object o, string name, params object[] args);
  void Set(object o, string name, object value);
  object Call(object o, string name, params object[] args);
  // Hands `handler` the source's event `name` (its default source interface's member).
  void Advise(object source, string name, Delegate handler);
  // Starts a program, or opens a document or URI with its handler (the switch).
  void Start(string file, string args);
  // The app's exe from App Paths, or null.
  string AppPath(string exe);
  void Foreground(int hwnd);
  // A visible top-level window of the named process with this class, the one whose title holds `title` first; 0 when
  // none (PowerPoint's slideshow window, which its object model does not name by IDispatch).
  int Window(string processName, string className, string title);
  // Lets go of a COM object now rather than when the collector gets to it.
  void Release(object o);
  // A new instance of the app, hidden (Render, with `start`: the box's Windows VM only).
  object Create(string progId);
  // The ids of the processes of that name; one process's identity (its name and start time) or null once it has
  // ended; and ending one (Render ends only an app it started itself, when Quit did not end it).
  List<int> Pids(string processName);
  string Identity(int pid);
  void Kill(int pid);
}

public class RealCom : ICom {
  public bool Registered(string progId) { return Type.GetTypeFromProgID(progId, false) != null; }
  public bool Running(string processName) { return Process.GetProcessesByName(processName).Length > 0; }
  // The running instance. Excel and Word enter the running object table only once their window has lost
  // the focus for the first time, so an app started a moment ago (the switch, or a PC nobody has clicked on)
  // is not there yet: its own window then hands out its object model (OBJID_NATIVEOM), focus or no focus.
  public object Active(string progId) {
    try { return Marshal.GetActiveObject(progId); }
    catch (COMException e) {
      if ((uint)e.ErrorCode != 0x800401E3) throw;
      var native = progId == "Excel.Application" ? Native("XLMAIN", "XLDESK", "EXCEL7") : progId == "Word.Application" ? Native("OpusApp", "_WwF", "_WwB", "_WwG") : null;
      if (native == null) throw;
      return native;
    }
  }
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IDispatch)] out object obj);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  // The Application behind the first window of that class chain that answers: main window, then each child class down to the document's.
  static object Native(params string[] classes) {
    var iid = new Guid("00020400-0000-0000-C000-000000000046");
    var top = IntPtr.Zero;
    while ((top = FindWindowEx(IntPtr.Zero, top, classes[0], null)) != IntPtr.Zero) {
      var h = top;
      for (var i = 1; i < classes.Length && h != IntPtr.Zero; i++) h = FindWindowEx(h, IntPtr.Zero, classes[i], null);
      if (h == IntPtr.Zero) continue;
      object window;
      if (AccessibleObjectFromWindow(h, 0xFFFFFFF0, ref iid, out window) != 0 || window == null) continue;
      try { return window.GetType().InvokeMember("Application", BindingFlags.GetProperty, null, window, null, CultureInfo.InvariantCulture); }
      catch (Exception) { }
      finally { Marshal.ReleaseComObject(window); }
    }
    return null;
  }
  static object Invoke(object o, string name, BindingFlags flags, object[] args) {
    try { return o.GetType().InvokeMember(name, flags, null, o, args, CultureInfo.InvariantCulture); }
    catch (TargetInvocationException e) { throw e.InnerException ?? e; }
  }
  public object Get(object o, string name, params object[] args) { return Invoke(o, name, BindingFlags.GetProperty, args); }
  public void Set(object o, string name, object value) {
    // An object-valued property (Outlook's SendUsingAccount) is set by reference.
    var flags = value != null && Marshal.IsComObject(value) ? BindingFlags.PutRefDispProperty : BindingFlags.SetProperty;
    Invoke(o, name, flags, new object[] { value });
  }
  // A method, or a property that takes arguments (a Range's Item): IDispatch takes both as one call.
  public object Call(object o, string name, params object[] args) { return Invoke(o, name, BindingFlags.InvokeMethod | BindingFlags.GetProperty, args); }
  public void Advise(object source, string name, Delegate handler) {
    Guid iid; int dispid;
    if (!EventId(source, name, out iid, out dispid)) {
      // Excel's AppEvents as its type library gives them, should the object not describe itself.
      if (name != "SheetChange") throw new Refusal("failed", "no event " + name + " on this object");
      iid = new Guid("00024413-0000-0000-C000-000000000046"); dispid = 0x61c;
    }
    ComEventsHelper.Combine(source, iid, dispid, handler);
  }

  // The event's interface and dispid, read from the object's own class info: its default source interface.
  static bool EventId(object source, string name, out Guid iid, out int dispid) {
    iid = Guid.Empty; dispid = 0;
    var pci = source as IProvideClassInfo;
    System.Runtime.InteropServices.ComTypes.ITypeInfo ti;
    if (pci == null || pci.GetClassInfo(out ti) != 0 || ti == null) return false;
    try {
      IntPtr pa; ti.GetTypeAttr(out pa);
      var ta = (System.Runtime.InteropServices.ComTypes.TYPEATTR)Marshal.PtrToStructure(pa, typeof(System.Runtime.InteropServices.ComTypes.TYPEATTR));
      ti.ReleaseTypeAttr(pa);
      const System.Runtime.InteropServices.ComTypes.IMPLTYPEFLAGS want = System.Runtime.InteropServices.ComTypes.IMPLTYPEFLAGS.IMPLTYPEFLAG_FDEFAULT | System.Runtime.InteropServices.ComTypes.IMPLTYPEFLAGS.IMPLTYPEFLAG_FSOURCE;
      for (var i = 0; i < ta.cImplTypes; i++) {
        System.Runtime.InteropServices.ComTypes.IMPLTYPEFLAGS f; ti.GetImplTypeFlags(i, out f);
        if ((f & want) != want) continue;
        int href; ti.GetRefTypeOfImplType(i, out href);
        System.Runtime.InteropServices.ComTypes.ITypeInfo ev; ti.GetRefTypeInfo(href, out ev);
        IntPtr pe; ev.GetTypeAttr(out pe);
        var ea = (System.Runtime.InteropServices.ComTypes.TYPEATTR)Marshal.PtrToStructure(pe, typeof(System.Runtime.InteropServices.ComTypes.TYPEATTR));
        ev.ReleaseTypeAttr(pe);
        var ids = new int[1];
        ev.GetIDsOfNames(new[] { name }, 1, ids);
        iid = ea.guid; dispid = ids[0];
        return true;
      }
    } catch (COMException) { }
    return false;
  }
  public void Start(string file, string args) {
    var p = new ProcessStartInfo(file);
    if (args != null) p.Arguments = args;
    p.UseShellExecute = true;
    Process.Start(p);
  }
  public string AppPath(string exe) {
    foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
      using (var k = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe)) {
        var v = k == null ? null : k.GetValue(null) as string;
        if (!string.IsNullOrEmpty(v) && File.Exists(v.Trim('"'))) return v.Trim('"');
      }
    }
    return null;
  }
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(int attach, int to, bool on);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);
  [DllImport("kernel32.dll")] static extern int GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int n);
  delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr arg);
  public void Release(object o) { if (o != null && Marshal.IsComObject(o)) Marshal.FinalReleaseComObject(o); }
  public object Create(string progId) { return Activator.CreateInstance(Type.GetTypeFromProgID(progId, true)); }
  public List<int> Pids(string processName) { var l = new List<int>(); foreach (var p in Process.GetProcessesByName(processName)) l.Add(p.Id); return l; }
  public string Identity(int pid) {
    try { var p = Process.GetProcessById(pid); if (p.HasExited) return null; return p.ProcessName + "|" + p.StartTime.ToUniversalTime().Ticks; }
    catch (Exception) { return null; }
  }
  public void Kill(int pid) { try { Process.GetProcessById(pid).Kill(); } catch (Exception) { } }
  // Windows refuses the foreground to a process with no input of its own, as this helper is; joined to the input
  // of the window in front for the moment, it is let through (proven in the box's VM, SLD679).
  public void Foreground(int hwnd) {
    var h = new IntPtr(hwnd);
    if (IsIconic(h)) ShowWindow(h, 9);
    int pid;
    var front = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    var me = GetCurrentThreadId();
    var joined = front != 0 && front != me && AttachThreadInput(me, front, true);
    try { BringWindowToTop(h); SetForegroundWindow(h); }
    finally { if (joined) AttachThreadInput(me, front, false); }
  }
  public int Window(string processName, string className, string title) {
    var pids = new HashSet<int>(Pids(processName));
    IntPtr first = IntPtr.Zero, named = IntPtr.Zero;
    EnumWindows((h, x) => {
      int pid;
      GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h)) return true;
      var s = new StringBuilder(512);
      GetClassName(h, s, s.Capacity);
      if (s.ToString() != className) return true;
      if (first == IntPtr.Zero) first = h;
      s.Clear();
      GetWindowText(h, s, s.Capacity);
      if (s.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) { named = h; return false; }
      return true;
    }, IntPtr.Zero);
    return (named != IntPtr.Zero ? named : first).ToInt32();
  }
}

[ComImport, Guid("B196B283-BAB4-101A-B69C-00AA00341D07"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IProvideClassInfo {
  [PreserveSig] int GetClassInfo(out System.Runtime.InteropServices.ComTypes.ITypeInfo info);
}

// Answers a busy app's "retry later" by retrying for a while, as Office's own clients do; past that
// the call fails with RPC_E_CALL_REJECTED, which TempCode shows as "busy, try again".
[ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IOleMessageFilter {
  [PreserveSig] int HandleInComingCall(int callType, IntPtr caller, int tickCount, IntPtr info);
  [PreserveSig] int RetryRejectedCall(IntPtr callee, int tickCount, int rejectType);
  [PreserveSig] int MessagePending(IntPtr callee, int tickCount, int pendingType);
}

class MessageFilter : IOleMessageFilter {
  public const int RetryMs = 10000;
  [DllImport("ole32.dll")] static extern int CoRegisterMessageFilter(IOleMessageFilter filter, out IOleMessageFilter old);
  public static void Register() { IOleMessageFilter old; CoRegisterMessageFilter(new MessageFilter(), out old); }
  public int HandleInComingCall(int callType, IntPtr caller, int tickCount, IntPtr info) { return 0; }
  public int RetryRejectedCall(IntPtr callee, int tickCount, int rejectType) { return rejectType == 2 && tickCount < RetryMs ? 250 : -1; }
  public int MessagePending(IntPtr callee, int tickCount, int pendingType) { return 2; }
}

public delegate void SheetChangeHandler(object sheet, object target);
public delegate void RemoteChangeHandler();

public class Office {
  public const int Version = 1;
  readonly ICom com;
  readonly Action<Dictionary<string, object>> emit;
  readonly Render render;
  readonly Present present;
  public Office(ICom com, Action<Dictionary<string, object>> emit) { this.com = com; this.emit = emit; render = new Render(com); present = new Present(com); }

  static readonly string[] APPS = { "excel", "word", "powerpoint", "outlook" };
  static string ProgId(string app) { return app == "excel" ? "Excel.Application" : app == "word" ? "Word.Application" : app == "powerpoint" ? "PowerPoint.Application" : "Outlook.Application"; }
  static string Proc(string app) { return app == "excel" ? "EXCEL" : app == "word" ? "WINWORD" : app == "powerpoint" ? "POWERPNT" : "OUTLOOK"; }
  static string Exe(string app) { return Proc(app).ToLowerInvariant() + ".exe"; }
  public static string Named(string app) { return app == "excel" ? "Microsoft Excel" : app == "word" ? "Microsoft Word" : app == "powerpoint" ? "Microsoft PowerPoint" : "Microsoft Outlook"; }

  // ---- attaching: the running app only, never a new one; a proxy left by an app that quit is dropped.
  readonly Dictionary<string, object> attached = new Dictionary<string, object>();
  bool watching;
  object advised;

  object App(string app) {
    object a = null;
    if (attached.TryGetValue(app, out a)) {
      try { com.Get(a, "Version"); }
      catch (COMException e) {
        // Busy is the app saying "not now", not gone: the caller hears it and tries again.
        if (Busy(e)) throw;
        Forget(app);
        a = null;
      }
    }
    if (a == null) {
      if (!com.Registered(ProgId(app))) throw new Refusal("not-installed", Named(app) + " is not installed on this PC.");
      if (!com.Running(Proc(app))) throw new Refusal("not-running", Named(app) + " is not open.");
      try { a = com.Active(ProgId(app)); }
      catch (COMException e) {
        if ((uint)e.ErrorCode == 0x800401E3) throw new Refusal("not-running", Named(app) + " is open but not reachable: it may be starting, or running as administrator while TempCode is not.");
        throw;
      }
      attached[app] = a;
    }
    // An app he closed while something held it stays alive, hidden, for its sake: that is not his app any more.
    if (Closed(app, a)) { Forget(app); throw new Refusal("not-running", Named(app) + " is not open."); }
    if (app == "excel" && watching) Advise(a);
    return a;
  }

  bool Closed(string app, object a) {
    try {
      if (app == "outlook") return Convert.ToInt32(com.Get(com.Get(a, "Explorers"), "Count")) == 0 && Convert.ToInt32(com.Get(com.Get(a, "Inspectors"), "Count")) == 0;
      return !Convert.ToBoolean(com.Get(a, "Visible"));
    } catch (COMException e) { if (Busy(e)) throw; return false; }
  }

  void Forget(string app) {
    object a;
    if (!attached.TryGetValue(app, out a)) return;
    attached.Remove(app);
    if (advised == a) advised = null;
    if (app == "excel") { foreach (var b in remoteBooks.Values) com.Release(b); remoteBooks.Clear(); }
    com.Release(a);
  }

  // After each request: hold no app but the Excel whose events are wanted, so closing an app ends it.
  public void AfterRequest() {
    foreach (var app in new List<string>(attached.Keys)) if (!(app == "excel" && watching)) Forget(app);
    GC.Collect();
    GC.WaitForPendingFinalizers();
    GC.Collect();
  }

  // Busy, or Outlook's guard: never mistaken for "no such thing".
  static void Keep(COMException e) { if (Busy(e) || (uint)e.ErrorCode == 0x80004004) throw e; }

  public static bool Busy(COMException e) { var h = (uint)e.ErrorCode; return h == 0x80010001 || h == 0x8001010A; }

  public object Apps() {
    var list = new List<object>();
    foreach (var app in APPS) {
      var has = com.Registered(ProgId(app));
      list.Add(Obj("app", app, "installed", has, "running", has && com.Running(Proc(app))));
    }
    return list;
  }

  // ---- Excel. A range is one call each way, never one per cell.
  int writing;
  // Workbooks whose AfterRemoteChange is ours, by FullName, for the Excel attached now: a book closed
  // and opened again is a new object, and is advised again.
  readonly Dictionary<string, object> remoteBooks = new Dictionary<string, object>();

  public object Watch(bool on) {
    watching = on;
    if (on && attached.ContainsKey("excel")) Advise(attached["excel"]);
    return null;
  }

  void Advise(object xl) {
    if (advised == xl) return;
    try { com.Advise(xl, "SheetChange", new SheetChangeHandler(SheetChanged)); advised = xl; }
    catch (Exception e) { Console.Error.WriteLine("tc-office: no SheetChange events: " + e.Message); }
  }

  void SheetChanged(object sheet, object target) {
    // Our own writes are told by TempCode itself; only someone else's change goes out.
    if (writing > 0 || !watching) return;
    try {
      var book = (string)com.Get(com.Get(sheet, "Parent"), "FullName");
      var address = (string)com.Get(target, "Address", false, false);
      emit(Obj("event", "changed", "book", book, "sheet", (string)com.Get(sheet, "Name"), "address", address));
    } catch (Exception e) { Console.Error.WriteLine("tc-office: SheetChange: " + e.Message); }
  }

  // A co-author's edits raise no SheetChange: Excel merges them and says so, with no range, by the
  // workbook's AfterRemoteChange. Heard for each workbook the helper reaches while listening.
  void AdviseBook(object b, string key) {
    object had;
    if (!watching || (remoteBooks.TryGetValue(key, out had) && ReferenceEquals(had, b))) return;
    remoteBooks[key] = b;
    try { com.Advise(b, "AfterRemoteChange", new RemoteChangeHandler(() => { if (watching) emit(Obj("event", "remote", "book", key)); })); }
    catch (Exception e) { Console.Error.WriteLine("tc-office: no AfterRemoteChange for " + key + ": " + e.Message); }
  }

  IEnumerable<object> Each(object collection) {
    var n = Convert.ToInt32(com.Get(collection, "Count"));
    for (var i = 1; i <= n; i++) yield return com.Call(collection, "Item", i);
  }

  object ByKey(object collection, string key, string what) {
    foreach (var x in Each(collection)) {
      if ((string)com.Get(x, "FullName") == key || (string)com.Get(x, "Name") == key) return x;
    }
    throw new Refusal("not-found", "No open " + what + " " + key + ".");
  }

  public object Workbooks() {
    var xl = App("excel");
    var list = new List<object>();
    foreach (var b in Each(com.Get(xl, "Workbooks"))) {
      var sheets = new List<object>();
      foreach (var s in Each(com.Get(b, "Worksheets"))) {
        var u = com.Get(s, "UsedRange");
        int r = Convert.ToInt32(com.Get(com.Get(u, "Rows"), "Count")), c = Convert.ToInt32(com.Get(com.Get(u, "Columns"), "Count"));
        if (r == 1 && c == 1 && Cell(com.Get(u, "Value")) == null) { sheets.Add(Obj("name", com.Get(s, "Name"), "rows", 0, "columns", 0)); continue; }
        sheets.Add(Obj("name", com.Get(s, "Name"), "rows", Convert.ToInt32(com.Get(u, "Row")) + r - 1, "columns", Convert.ToInt32(com.Get(u, "Column")) + c - 1));
      }
      list.Add(Obj("key", com.Get(b, "FullName"), "name", com.Get(b, "Name"), "sheets", sheets));
    }
    return list;
  }

  object Range(string book, string sheet, string address) {
    var b = ByKey(com.Get(App("excel"), "Workbooks"), book, "workbook");
    AdviseBook(b, book);
    object ws;
    try { ws = com.Call(com.Get(b, "Worksheets"), "Item", sheet); }
    catch (COMException e) { Keep(e); throw new Refusal("not-found", book + " has no sheet " + sheet + "."); }
    return com.Get(ws, "Range", address);
  }

  // Formula2 is a cell's formula as an Excel with dynamic arrays keeps it. An Excel before them does not know the
  // name; one without them (Excel 2019, or the box's VM, Microsoft 365 16.0.20625, where SEQUENCE is #NAME?)
  // knows it and refuses every call with 0x800A03EC, as it does HasSpill. There Formula is the same formula. A
  // write that 0x800A03EC refuses for its own sake (a bad formula, a locked cell) is refused by Formula again.
  public static bool NoFormula2(COMException e) { var h = (uint)e.ErrorCode; return h == 0x80020006 || h == 0x800A03EC; }

  public object ReadRange(string book, string sheet, string address) {
    var r = Range(book, sheet, address);
    var values = Grid(com.Get(r, "Value"));
    object f;
    try { f = com.Get(r, "Formula2"); }
    catch (COMException e) { if (!NoFormula2(e)) throw; f = com.Get(r, "Formula"); }
    var formulas = Grid(f);
    var rows = values.Length;
    var cols = rows > 0 ? values[0].Length : 0;
    var outV = new List<object>(); var outF = new List<object>();
    for (var i = 0; i < rows; i++) {
      var rv = new List<object>(); var rf = new List<object>();
      for (var j = 0; j < cols; j++) {
        rv.Add(Cell(values[i][j]));
        var s = formulas[i][j] as string;
        rf.Add(s != null && s.StartsWith("=") ? s : "");
      }
      outV.Add(rv); outF.Add(rf);
    }
    var formats = new string[rows, cols];
    Formats(r, 0, 0, rows, cols, formats, 0);
    var outZ = new List<object>();
    for (var i = 0; i < rows; i++) { var rz = new List<object>(); for (var j = 0; j < cols; j++) rz.Add(formats[i, j] ?? ""); outZ.Add(rz); }
    return Obj("values", outV, "formulas", outF, "formats", outZ);
  }

  // NumberFormat answers null for a range whose cells differ: then by row, then by cell.
  void Formats(object r, int top, int left, int rows, int cols, string[,] into, int depth) {
    var z = com.Get(r, "NumberFormat");
    if (z is string) { for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) into[top + i, left + j] = (string)z; return; }
    var arr = z as Array;
    if (arr != null && arr.Rank == 2) { var g = Grid(arr); for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) into[top + i, left + j] = g[i][j] as string; return; }
    if (rows == 1 && cols == 1) return;
    if (depth == 0 && rows > 1) { for (var i = 1; i <= rows; i++) Formats(com.Call(com.Get(r, "Rows"), "Item", i), top + i - 1, left, 1, cols, into, 1); return; }
    for (var j = 1; j <= cols; j++) Formats(com.Call(com.Get(r, "Cells"), "Item", 1, j), top, left + j - 1, 1, 1, into, 2);
  }

  public object WriteRange(string book, string sheet, string address, ArrayList grid) {
    var r = Range(book, sheet, address);
    var rows = grid.Count;
    var cols = rows > 0 ? ((ArrayList)grid[0]).Count : 0;
    var formulas = false;
    foreach (ArrayList row in grid) foreach (var c in row) { var s = c as string; if (s != null && s.StartsWith("=")) formulas = true; }
    var a = new object[rows, cols];
    for (var i = 0; i < rows; i++) {
      var row = (ArrayList)grid[i];
      for (var j = 0; j < cols; j++) a[i, j] = formulas ? (object)FormulaText(row[j]) : Out(row[j]);
    }
    writing++;
    try {
      object v = rows == 1 && cols == 1 ? a[0, 0] : a;
      if (!formulas) com.Set(r, "Value", v);
      else {
        try { com.Set(r, "Formula2", v); }
        catch (COMException e) { if (!NoFormula2(e)) throw; com.Set(r, "Formula", v); }
      }
    } finally { writing--; }
    return null;
  }

  static readonly Dictionary<int, string> ERRORS = new Dictionary<int, string> {
    { -2146826281, "#DIV/0!" }, { -2146826246, "#N/A" }, { -2146826259, "#NAME?" }, { -2146826288, "#NULL!" },
    { -2146826252, "#NUM!" }, { -2146826265, "#REF!" }, { -2146826273, "#VALUE!" }, { -2146826245, "#GETTING_DATA" },
    { -2146826238, "#SPILL!" }, { -2146826215, "#CALC!" }
  };

  // A cell as JSON: a number, text, true or false, or null when empty. A date is ISO text in UTC, as the Mac gives it.
  static object Cell(object v) {
    if (v == null || v is DBNull) return null;
    if (v is string) return (string)v == "" ? null : v;
    if (v is bool) return v;
    if (v is DateTime) return Iso((DateTime)v);
    // Excel gives every number as a double; a bare int is a cell's error value.
    if (v is int) { string e; return ERRORS.TryGetValue((int)v, out e) ? e : "#ERROR"; }
    if (v is double || v is decimal || v is float || v is long || v is short || v is byte) return Convert.ToDouble(v, CultureInfo.InvariantCulture);
    return Convert.ToString(v, CultureInfo.InvariantCulture);
  }

  static object Out(object v) {
    var s = v as string;
    if (s != null && IsoText.IsMatch(s)) return DateTime.Parse(s, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToLocalTime();
    if (v is int || v is long || v is decimal) return Convert.ToDouble(v, CultureInfo.InvariantCulture);
    return v;
  }

  static string FormulaText(object v) {
    if (v == null) return "";
    if (v is bool) return (bool)v ? "TRUE" : "FALSE";
    var s = v as string;
    // A date among formulas goes in as its serial, so it stays a date (the cell keeps its format).
    if (s != null && IsoText.IsMatch(s)) return ((DateTime)Out(s)).ToOADate().ToString("R", CultureInfo.InvariantCulture);
    if (s != null) return s;
    return Convert.ToString(Convert.ToDouble(v, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
  }

  static readonly System.Text.RegularExpressions.Regex IsoText = new System.Text.RegularExpressions.Regex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$");
  static string Iso(DateTime d) {
    if (d.Kind == DateTimeKind.Unspecified) d = DateTime.SpecifyKind(d, DateTimeKind.Local);
    return d.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
  }

  // A block as rows: COM hands a single cell as a scalar and a block as a 1-based object[,].
  static object[][] Grid(object x) {
    var a = x as Array;
    if (a == null || a.Rank != 2) return new[] { new[] { x } };
    int r0 = a.GetLowerBound(0), c0 = a.GetLowerBound(1), rows = a.GetLength(0), cols = a.GetLength(1);
    var g = new object[rows][];
    for (var i = 0; i < rows; i++) { g[i] = new object[cols]; for (var j = 0; j < cols; j++) g[i][j] = a.GetValue(r0 + i, c0 + j); }
    return g;
  }

  // ---- Word
  public object Documents() { return Files(com.Get(App("word"), "Documents")); }
  public object Presentations() { return Files(com.Get(App("powerpoint"), "Presentations")); }

  object Files(object collection) {
    var list = new List<object>();
    foreach (var f in Each(collection)) list.Add(Obj("key", com.Get(f, "FullName"), "name", com.Get(f, "Name")));
    return list;
  }

  public object ReadDocument(string doc) {
    var d = ByKey(com.Get(App("word"), "Documents"), doc, "document");
    return new List<string>(((string)com.Get(com.Get(d, "Content"), "Text")).Split('\r'));
  }

  public object EditDocument(string doc, Dictionary<string, object> edit, bool tracked) {
    var d = ByKey(com.Get(App("word"), "Documents"), doc, "document");
    var was = Convert.ToBoolean(com.Get(d, "TrackRevisions"));
    com.Set(d, "TrackRevisions", tracked);
    try {
      var content = com.Get(d, "Content");
      if (edit.ContainsKey("insert")) {
        com.Call(content, (string)edit["at"] == "start" ? "InsertBefore" : "InsertAfter", (string)edit["insert"]);
        return 1;
      }
      var find = (string)edit["find"];
      var replace = (string)edit["replace"];
      if (find.Length == 0) throw new Refusal("failed", "Nothing to find.");
      if (find.Length > 255) throw new Refusal("failed", "Word finds at most 255 characters at a time: find a shorter piece.");
      // Find sees the final text only: no tracked deletion, his own or ours, is found and "replaced" again.
      object filter = null, markup = null, view = null;
      try { filter = com.Get(com.Get(com.Get(d, "ActiveWindow"), "View"), "RevisionsFilter"); markup = com.Get(filter, "Markup"); view = com.Get(filter, "View"); com.Set(filter, "Markup", 0); com.Set(filter, "View", 0); }
      catch (COMException e) { Keep(e); filter = null; }
      try {
        // Find, set the found range's text, go on after it: Word's own replace takes at most 255 characters.
        var r = com.Get(d, "Content");
        var f = com.Get(r, "Find");
        // His last Find dialog's settings stay on Find: every one is set here.
        com.Call(f, "ClearFormatting");
        foreach (var flag in new[] { "Format", "MatchWildcards", "MatchWholeWord", "MatchSoundsLike", "MatchAllWordForms", "MatchPrefix", "MatchSuffix", "IgnoreSpace", "IgnorePunct" }) {
          try { com.Set(f, flag, false); } catch (COMException e) { Keep(e); }
        }
        com.Set(f, "MatchCase", true);
        com.Set(f, "Forward", true);
        com.Set(f, "Wrap", 0);
        com.Set(f, "Text", find.Replace("^", "^^"));
        int n = 0, last = -1, lastStart = -1;
        while (n < 10000 && Convert.ToBoolean(com.Call(f, "Execute"))) {
          var start = Convert.ToInt32(com.Get(r, "Start"));
          // A hit behind the last, or a tracked deletion found where the last one was: nothing more to do.
          if (start < last || (tracked && replace.Length == 0 && start == lastStart)) break;
          com.Set(r, "Text", replace);
          lastStart = start;
          last = Convert.ToInt32(com.Get(r, "End"));
          n++;
          com.Call(r, "SetRange", last, Convert.ToInt32(com.Get(com.Get(d, "Content"), "End")));
        }
        return n;
      } finally {
        if (filter != null) { com.Set(filter, "Markup", markup); com.Set(filter, "View", view); }
      }
    } finally { com.Set(d, "TrackRevisions", was); }
  }

  // ---- PowerPoint
  IEnumerable<object> TextShapes(object pres) {
    foreach (var s in Each(com.Get(pres, "Slides"))) {
      var shapes = new List<object>();
      foreach (var h in Each(com.Get(s, "Shapes"))) if (Convert.ToInt32(com.Get(h, "HasTextFrame")) != 0) shapes.Add(h);
      yield return shapes;
    }
  }

  public object ReadSlides(string pres) {
    var p = ByKey(com.Get(App("powerpoint"), "Presentations"), pres, "presentation");
    var list = new List<object>();
    var i = 0;
    foreach (List<object> shapes in TextShapes(p)) {
      var texts = new List<object>();
      foreach (var h in shapes) texts.Add((string)com.Get(com.Get(com.Get(h, "TextFrame"), "TextRange"), "Text"));
      list.Add(Obj("index", ++i, "texts", texts));
    }
    return list;
  }

  public object ReplaceSlideText(string pres, string find, string replace) {
    if (find.Length == 0) throw new Refusal("failed", "Nothing to find.");
    var p = ByKey(com.Get(App("powerpoint"), "Presentations"), pres, "presentation");
    var n = 0;
    foreach (List<object> shapes in TextShapes(p)) {
      foreach (var h in shapes) {
        var t = com.Get(com.Get(h, "TextFrame"), "TextRange");
        if (((string)com.Get(t, "Text")).IndexOf(find, StringComparison.Ordinal) < 0) continue;
        // TextRange.Replace keeps each run's formatting; After moves past the text it put in.
        var after = 0;
        for (var k = 0; k < 10000; k++) {
          var hit = com.Call(t, "Replace", find, replace, after, -1, 0);
          if (hit == null) break;
          after = Convert.ToInt32(com.Get(hit, "Start")) + Convert.ToInt32(com.Get(hit, "Length")) - 1;
        }
        n++;
      }
    }
    return n;
  }

  // ---- Outlook, as LifeOS's outlook.ps1 does it.
  const string PR_SMTP = "http://schemas.microsoft.com/mapi/proptag/0x39FE001F";
  const string PR_SENDER_SMTP = "http://schemas.microsoft.com/mapi/proptag/0x5D01001F";

  object Ns() { return com.Call(App("outlook"), "GetNamespace", "MAPI"); }

  static string Lower(object s) { return s == null ? "" : Convert.ToString(s, CultureInfo.InvariantCulture).Trim().ToLowerInvariant(); }

  object Prop(object item, string tag) {
    try { return com.Call(com.Get(item, "PropertyAccessor"), "GetProperty", tag); }
    catch (COMException e) { Keep(e); return null; }
  }

  string SmtpOf(object recipient) {
    var smtp = Lower(Prop(recipient, PR_SMTP));
    if (smtp != "") return smtp;
    try {
      var entry = com.Get(recipient, "AddressEntry");
      try { var u = com.Call(entry, "GetExchangeUser"); if (u != null) { var p = Lower(com.Get(u, "PrimarySmtpAddress")); if (p != "") return p; } } catch (COMException e) { Keep(e); }
      var a = Lower(com.Get(entry, "Address"));
      if (a.Contains("@")) return a;
    } catch (COMException e) { Keep(e); }
    return "";
  }

  string SenderOf(object item) {
    var smtp = Lower(Prop(item, PR_SENDER_SMTP));
    if (smtp != "") return smtp;
    if (Lower(com.Get(item, "SenderEmailType")) == "smtp") return Lower(com.Get(item, "SenderEmailAddress"));
    try { var u = com.Call(com.Get(item, "Sender"), "GetExchangeUser"); if (u != null) return Lower(com.Get(u, "PrimarySmtpAddress")); } catch (COMException e) { Keep(e); }
    return "";
  }

  List<object> Accounts(object ns) {
    var list = new List<object>();
    foreach (var a in Each(com.Get(ns, "Accounts"))) if (Lower(com.Get(a, "SmtpAddress")) != "") list.Add(a);
    return list;
  }

  public object AccountList() {
    var list = new List<object>();
    foreach (var a in Accounts(Ns())) list.Add(Lower(com.Get(a, "SmtpAddress")));
    return list;
  }

  object Account(object ns, string address) {
    foreach (var a in Accounts(ns)) if (Lower(com.Get(a, "SmtpAddress")) == Lower(address)) return a;
    throw new Refusal("not-found", "Outlook has no account " + address + ".");
  }

  string AccountOfStore(object ns, object store) {
    string id = null;
    try { id = (string)com.Get(store, "StoreID"); } catch (COMException) { }
    var all = Accounts(ns);
    foreach (var a in all) { try { if ((string)com.Get(com.Get(a, "DeliveryStore"), "StoreID") == id) return Lower(com.Get(a, "SmtpAddress")); } catch (COMException) { } }
    return all.Count > 0 ? Lower(com.Get(all[0], "SmtpAddress")) : "";
  }

  // Outlook says 4501-01-01 for "no date".
  static string When(object d) {
    if (!(d is DateTime) || ((DateTime)d).Year >= 4501) return null;
    return Iso((DateTime)d);
  }

  Dictionary<string, object> Summary(object ns, object item, string account) {
    var at = When(com.Get(item, "ReceivedTime")) ?? When(com.Get(item, "SentOn")) ?? When(com.Get(item, "LastModificationTime")) ?? "1970-01-01T00:00:00.000Z";
    return Obj("id", com.Get(item, "EntryID"), "account", account, "from", SenderOf(item), "subject", (string)com.Get(item, "Subject") ?? "", "at", at, "read", !Convert.ToBoolean(com.Get(item, "UnRead")));
  }

  public object ListMail(string folder, int limit, string query) {
    var ns = Ns();
    var f = com.Call(ns, "GetDefaultFolder", folder == "sent" ? 5 : folder == "drafts" ? 16 : 6);
    var account = AccountOfStore(ns, com.Get(f, "Store"));
    var items = com.Get(f, "Items");
    if (!string.IsNullOrEmpty(query)) items = com.Call(items, "Restrict", "@SQL=\"urn:schemas:httpmail:subject\" like '%" + query.Replace("'", "''") + "%'");
    // Sorting and stopping needs no date filter, so neither Jet's locale nor DASL's time zone can drop a mail.
    com.Call(items, "Sort", folder == "drafts" ? "[LastModificationTime]" : folder == "sent" ? "[SentOn]" : "[ReceivedTime]", true);
    var list = new List<object>();
    var item = com.Call(items, "GetFirst");
    while (item != null && list.Count < limit) {
      if (Convert.ToInt32(com.Get(item, "Class")) == 43) list.Add(Summary(ns, item, account));
      item = com.Call(items, "GetNext");
    }
    return list;
  }

  object ItemById(object ns, string id) {
    try { return com.Call(ns, "GetItemFromID", id); }
    catch (COMException e) { Keep(e); throw new Refusal("not-found", "Outlook has no item " + id + "."); }
  }

  List<object> RecipientsOf(object item, int type) {
    var list = new List<object>();
    foreach (var r in Each(com.Get(item, "Recipients"))) if (Convert.ToInt32(com.Get(r, "Type")) == type) list.Add(SmtpOf(r));
    return list;
  }

  public object ReadMail(string id) {
    var ns = Ns();
    var m = ItemById(ns, id);
    var o = Summary(ns, m, AccountOfStore(ns, com.Get(com.Get(m, "Parent"), "Store")));
    o["to"] = RecipientsOf(m, 1);
    o["cc"] = RecipientsOf(m, 2);
    o["text"] = (string)com.Get(m, "Body") ?? "";
    return o;
  }

  // Our HTML just inside the body, above Outlook's quoted original.
  void InsertHtml(object mail, string html) {
    var existing = (string)com.Get(mail, "HTMLBody") ?? "";
    var m = System.Text.RegularExpressions.Regex.Match(existing, "<body[^>]*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    com.Set(mail, "HTMLBody", m.Success ? existing.Substring(0, m.Index + m.Length) + html + existing.Substring(m.Index + m.Length) : html + existing);
  }

  void AddRecipients(object mail, object list, int type) {
    var all = list as ArrayList;
    if (all == null) return;
    foreach (var a in all) com.Set(com.Call(com.Get(mail, "Recipients"), "Add", (string)a), "Type", type);
  }

  // Whatever fails before Send was never sent: a refusal (the route fails its row). Only Send itself may end unclear.
  static Exception Unsent(string what, Exception e) {
    if (e is Refusal) return e;
    var c = e as COMException;
    if (c != null && (Busy(c) || (uint)c.ErrorCode == 0x80004004)) return e;
    return new Refusal("refused", "Outlook would not make this " + what + ", so nothing was sent: " + e.Message);
  }

  // Send itself. Busy and the guard turned it away before it ran; anything else may have sent it.
  void SendNow(object item, string what) {
    try { com.Call(item, "Send"); }
    catch (COMException e) {
      if (Busy(e) || (uint)e.ErrorCode == 0x80004004) throw;
      throw new Refusal("failed", "Outlook stopped while sending this " + what + " (" + e.Message + "): it may have gone. Look in Sent before sending it again.");
    }
  }

  // Before a send, every recipient must be one Outlook knows.
  void Resolved(object item) {
    var rs = com.Get(item, "Recipients");
    if (Convert.ToBoolean(com.Call(rs, "ResolveAll"))) return;
    var names = new List<string>();
    foreach (var r in Each(rs)) if (!Convert.ToBoolean(com.Get(r, "Resolved"))) names.Add((string)com.Get(r, "Name"));
    throw new Refusal("not-found", "Outlook does not know " + string.Join(", ", names.ToArray()) + ", so nothing was sent.");
  }

  // A draft left in Drafts (answers its id), or a mail sent: only ever from a held act's execute, after his press.
  public object Mail(Dictionary<string, object> m, bool send) {
    object mail;
    try { mail = MakeMail(m, send); } catch (Exception e) { throw Unsent("mail", e); }
    if (!send) return com.Get(mail, "EntryID");
    SendNow(mail, "mail");
    return null;
  }

  object MakeMail(Dictionary<string, object> m, bool send) {
    var ns = Ns();
    var app = App("outlook");
    object mail;
    var html = (string)m["html"] ?? "";
    var reply = m.ContainsKey("replyTo") && m["replyTo"] != null;
    var forward = !reply && m.ContainsKey("forward") && m["forward"] != null;
    if (reply) {
      mail = com.Call(ItemById(ns, (string)m["replyTo"]), "Reply");
      // A reply he pressed goes to the held To alone, the sender the card showed: Outlook addresses it from the mail
      // (its Reply-To, say), so those recipients are taken off and the held ones put on. A draft keeps Outlook's.
      if (send) { ClearRecipients(mail); AddRecipients(mail, m["to"], 1); }
      InsertHtml(mail, html);
    } else if (forward) {
      mail = com.Call(ItemById(ns, (string)m["forward"]), "Forward");
      AddRecipients(mail, m["to"], 1);
      InsertHtml(mail, html);
    } else {
      mail = com.Call(app, "CreateItem", 0);
      AddRecipients(mail, m["to"], 1);
      com.Set(mail, "Subject", (string)m["subject"] ?? "");
      com.Set(mail, "HTMLBody", html);
    }
    AddRecipients(mail, m["cc"], 2);
    AddRecipients(mail, m["bcc"], 3);
    var account = m.ContainsKey("account") ? m["account"] as string : null;
    if (!string.IsNullOrEmpty(account)) com.Set(mail, "SendUsingAccount", Account(ns, account));
    if (send) Resolved(mail);
    else { com.Call(com.Get(mail, "Recipients"), "ResolveAll"); com.Call(mail, "Save"); }
    // Then what Outlook holds is read back (the hold review's 21.1): anyone but the held recipients, or one of them
    // missing, and the mail is thrown away unsent. The words are carrier.ts recipientsOff's.
    if (send && (reply || forward)) {
      var held = new[] { Lowered(m["to"]), Lowered(m["cc"]), Lowered(m["bcc"]) };
      var built = new[] { Lowered(RecipientsOf(mail, 1)), Lowered(RecipientsOf(mail, 2)), Lowered(RecipientsOf(mail, 3)) };
      var same = true;
      for (var i = 0; i < 3; i++) if (string.Join("\n", held[i].ToArray()) != string.Join("\n", built[i].ToArray())) same = false;
      if (!same) {
        try { com.Call(mail, "Delete"); } catch (COMException e) { Keep(e); }
        throw new Refusal("refused", "Outlook made this " + (reply ? "reply" : "forward") + " for " + Listed(built) + ", not " + Listed(held) + " as held, so nothing was sent.");
      }
    }
    return mail;
  }

  // Every recipient off a mail, last first. One Outlook will not let go stays, and the read-back above refuses the mail.
  void ClearRecipients(object mail) {
    var rs = com.Get(mail, "Recipients");
    for (var i = Convert.ToInt32(com.Get(rs, "Count")); i >= 1; i--) {
      try { com.Call(rs, "Remove", i); } catch (COMException e) { Keep(e); }
    }
  }

  // Addresses as one field holds them: trimmed, lower case, each once, sorted.
  static List<string> Lowered(object list) {
    var all = list as IEnumerable;
    var set = new SortedSet<string>(StringComparer.Ordinal);
    if (all != null) foreach (var a in all) { var x = (Convert.ToString(a) ?? "").Trim().ToLowerInvariant(); if (x != "") set.Add(x); }
    return new List<string>(set);
  }

  static string Listed(List<string>[] r) {
    var names = new[] { "To", "Cc", "Bcc" };
    var parts = new List<string>();
    for (var i = 0; i < 3; i++) if (r[i].Count > 0) parts.Add(names[i] + " " + string.Join(", ", r[i].ToArray()));
    return parts.Count > 0 ? string.Join("; ", parts.ToArray()) : "nobody";
  }

  object Calendar(object ns, string account) {
    if (string.IsNullOrEmpty(account)) return com.Call(ns, "GetDefaultFolder", 9);
    return com.Call(com.Get(Account(ns, account), "DeliveryStore"), "GetDefaultFolder", 9);
  }

  // Events starting in [from, to): sorted, recurrences expanded, then restricted, in that order.
  IEnumerable<object> Between(object folder, DateTime from, DateTime to, int most = 500) {
    var items = com.Get(folder, "Items");
    com.Call(items, "Sort", "[Start]");
    com.Set(items, "IncludeRecurrences", true);
    var f = "[Start] >= '" + from.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) + "' AND [Start] < '" + to.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) + "'";
    var hits = com.Call(items, "Restrict", f);
    var item = com.Call(hits, "GetFirst");
    for (var n = 0; item != null && n < most; n++) {
      yield return item;
      item = com.Call(hits, "GetNext");
    }
  }

  static DateTime Parse(object iso) { return DateTime.Parse((string)iso, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind); }

  public object Events(string from, string to) {
    var ns = Ns();
    var list = new List<object>();
    foreach (var e in Between(com.Call(ns, "GetDefaultFolder", 9), Parse(from), Parse(to))) {
      var attendees = new List<object>();
      foreach (var r in Each(com.Get(e, "Recipients"))) attendees.Add(SmtpOf(r));
      var status = Convert.ToInt32(com.Get(e, "ResponseStatus"));
      list.Add(Obj("id", com.Get(e, "EntryID"), "subject", (string)com.Get(e, "Subject") ?? "", "start", Iso((DateTime)com.Get(e, "Start")), "end", Iso((DateTime)com.Get(e, "End")),
        "location", (string)com.Get(e, "Location") ?? "", "organizer", (string)com.Get(e, "Organizer") ?? "", "attendees", attendees,
        "response", status == 2 ? "tentative" : status == 3 ? "accepted" : status == 4 ? "declined" : status == 5 ? "not answered" : ""));
    }
    return list;
  }

  // Only from a held act's execute, or a plain hold on his own calendar with nobody invited.
  public object CreateEvent(Dictionary<string, object> e) {
    var attendees = e["attendees"] as ArrayList;
    var invites = attendees != null && attendees.Count > 0;
    object a;
    try { a = MakeEvent(e, attendees, invites); } catch (Exception x) { throw Unsent("invitation", x); }
    if (!invites) { com.Call(a, "Save"); return com.Get(a, "EntryID"); }
    // Sent before it is saved, so an invitation Outlook turns away leaves no meeting behind; Send saves it.
    SendNow(a, "invitation");
    try { return com.Get(a, "EntryID"); } catch (COMException) { return null; }
  }

  object MakeEvent(Dictionary<string, object> e, ArrayList attendees, bool invites) {
    var ns = Ns();
    var items = com.Get(Calendar(ns, e.ContainsKey("account") ? e["account"] as string : null), "Items");
    var a = com.Call(items, "Add", 1);
    com.Set(a, "Subject", (string)e["subject"] ?? "");
    com.Set(a, "Start", Parse(e["start"]).ToLocalTime());
    com.Set(a, "End", Parse(e["end"]).ToLocalTime());
    if (e.ContainsKey("location") && e["location"] != null) com.Set(a, "Location", (string)e["location"]);
    if (e.ContainsKey("body") && e["body"] != null) com.Set(a, "Body", (string)e["body"]);
    if (invites) {
      com.Set(a, "MeetingStatus", 1);
      AddRecipients(a, attendees, 1);
      Resolved(a);
    }
    return a;
  }

  // The event whose iCalendar UID is `uid`: Outlook's own GlobalAppointmentID in hex, or one carrying a vCal-Uid.
  public object EventByUid(string uid) {
    var ns = Ns();
    var now = DateTime.UtcNow;
    var want = Clean(uid);
    foreach (var e in Between(com.Call(ns, "GetDefaultFolder", 9), now.AddDays(-7), now.AddDays(183), 20000)) {
      var g = (string)com.Get(e, "GlobalAppointmentID") ?? "";
      if (string.Equals(Clean(g), want, StringComparison.OrdinalIgnoreCase) || VCalUid(g) == uid) return com.Get(e, "EntryID");
    }
    return null;
  }

  // An occurrence's GlobalObjectId carries its date in bytes 16 to 19; the series' id has zeros there.
  public static string Clean(string hex) {
    if (hex.Length < 40 || !System.Text.RegularExpressions.Regex.IsMatch(hex, "^[0-9A-Fa-f]+$")) return hex;
    return hex.Substring(0, 32) + "00000000" + hex.Substring(40);
  }

  // A GlobalObjectId: 40 bytes of header and a size, then "vCal-Uid", 01 00 00 00 and the UID ending in a nul.
  public static string VCalUid(string hex) {
    if (hex.Length < 104 || hex.Length % 2 != 0) return null;
    var b = new byte[hex.Length / 2];
    for (var i = 0; i < b.Length; i++) { int v; if (!int.TryParse(hex.Substring(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v)) return null; b[i] = (byte)v; }
    var mark = Encoding.ASCII.GetBytes("vCal-Uid");
    for (var i = 0; i < mark.Length; i++) if (b[40 + i] != mark[i]) return null;
    var start = 40 + mark.Length + 4;
    var end = Array.IndexOf(b, (byte)0, start);
    return Encoding.UTF8.GetString(b, start, (end < 0 ? b.Length : end) - start);
  }

  // Only from a held act's execute.
  public object AnswerEvent(string id, string answer, string comment) {
    object r;
    try {
      var e = ItemById(Ns(), id);
      r = com.Call(e, "Respond", answer == "accept" ? 3 : answer == "decline" ? 4 : 2, true);
      if (r != null && !string.IsNullOrEmpty(comment)) com.Set(r, "Body", comment);
    } catch (Exception x) { throw Unsent("answer", x); }
    if (r != null) SendNow(r, "answer");
    return null;
  }

  // ---- the switch: the file's window forward when the app has it open, else the app started with it.
  public object Open(string app, Dictionary<string, object> r) {
    var path = r.ContainsKey("path") ? r["path"] as string : null;
    var url = r.ContainsKey("url") ? r["url"] as string : null;
    var key = path ?? url;
    if (!com.Registered(ProgId(app))) throw new Refusal("not-installed", Named(app) + " is not installed on this PC.");
    object open = null, a = null;
    if (app != "outlook" && com.Running(Proc(app))) {
      try {
        a = App(app);
        foreach (var d in Each(com.Get(a, app == "excel" ? "Workbooks" : app == "word" ? "Documents" : "Presentations"))) if ((string)com.Get(d, "FullName") == key) { open = d; break; }
      } catch (Refusal) { }
    }
    if (open != null) {
      com.Call(open, "Activate");
      if (app != "powerpoint") com.Set(a, "Visible", true);
      // Windows may refuse a background process the foreground; the window is active in its app either way.
      try {
        var hwnd = app == "excel" ? com.Get(a, "Hwnd") : app == "word" ? com.Get(com.Get(open, "ActiveWindow"), "Hwnd") : com.Get(com.Call(com.Get(open, "Windows"), "Item", 1), "HWND");
        com.Foreground(Convert.ToInt32(hwnd));
      } catch (COMException) { }
      return null;
    }
    if (url != null) { com.Start("ms-" + app + ":ofe|u|" + url, null); return null; }
    var exe = com.AppPath(Exe(app));
    if (exe == null) throw new Refusal("not-installed", Named(app) + " is not installed on this PC.");
    com.Start(exe, "\"" + path + "\"");
    return null;
  }

  // ---- one request
  public static Dictionary<string, object> Obj(params object[] kv) {
    var o = new Dictionary<string, object>();
    for (var i = 0; i + 1 < kv.Length; i += 2) o[(string)kv[i]] = kv[i + 1];
    return o;
  }

  public object Run(string verb, Dictionary<string, object> a) {
    if (Render.Has(verb)) return render.Run(verb, a);
    if (Present.Has(verb)) return present.Run(verb, a);
    switch (verb) {
      case "apps": return Apps();
      case "watch": return Watch(Convert.ToBoolean(a["on"]));
      case "workbooks": return Workbooks();
      case "readRange": return ReadRange((string)a["book"], (string)a["sheet"], (string)a["address"]);
      case "writeRange": return WriteRange((string)a["book"], (string)a["sheet"], (string)a["address"], (ArrayList)a["grid"]);
      case "documents": return Documents();
      case "readDocument": return ReadDocument((string)a["doc"]);
      case "editDocument": return EditDocument((string)a["doc"], (Dictionary<string, object>)a["edit"], Convert.ToBoolean(a["tracked"]));
      case "presentations": return Presentations();
      case "readSlides": return ReadSlides((string)a["pres"]);
      case "replaceSlideText": return ReplaceSlideText((string)a["pres"], (string)a["find"], (string)a["replace"]);
      case "accounts": return AccountList();
      case "listMail": return ListMail((string)a["folder"], Convert.ToInt32(a["limit"]), a.ContainsKey("query") ? a["query"] as string : null);
      case "readMail": return ReadMail((string)a["id"]);
      case "mail": return Mail((Dictionary<string, object>)a["m"], Convert.ToBoolean(a["send"]));
      case "events": return Events((string)a["from"], (string)a["to"]);
      case "createEvent": return CreateEvent((Dictionary<string, object>)a["e"]);
      case "eventByUid": return EventByUid((string)a["uid"]);
      case "answerEvent": return AnswerEvent((string)a["id"], (string)a["answer"], a.ContainsKey("comment") ? a["comment"] as string : null);
      case "open": return Open((string)a["app"], (Dictionary<string, object>)a["ref"]);
    }
    throw new Refusal("failed", "tc-office has no verb " + verb + ".");
  }

  static readonly Dictionary<string, string> APP_OF_VERB = new Dictionary<string, string> {
    { "workbooks", "excel" }, { "readRange", "excel" }, { "writeRange", "excel" }, { "documents", "word" }, { "readDocument", "word" }, { "editDocument", "word" },
    { "presentations", "powerpoint" }, { "readSlides", "powerpoint" }, { "replaceSlideText", "powerpoint" }, { "present.run", "powerpoint" }
  };

  // Any failure as {code, message, hresult}: COM's own codes in words.
  public static Dictionary<string, object> Failure(string verb, Exception e) {
    var r = e as Refusal;
    if (r != null) return Obj("code", r.Code, "message", r.Message);
    if (Guest.Has(verb)) return Obj("code", "failed", "message", e.Message);
    if (Render.Has(verb)) {
      var busy = e as COMException;
      if (busy != null && Busy(busy)) return Obj("code", "busy", "message", "Office is busy with a dialog: try again once it is closed.", "hresult", "0x" + ((uint)busy.ErrorCode).ToString("X8"));
      return Obj("code", "failed", "message", "Office could not render the copy: " + e.Message);
    }
    string app;
    // `open` names its app in its arguments, not its verb: a failure there is Office's, whichever app it was.
    var name = APP_OF_VERB.TryGetValue(verb, out app) ? Named(app) : verb == "open" ? "Office" : Named("outlook");
    var com = e as COMException;
    var h = com != null ? (uint)com.ErrorCode : (uint)Marshal.GetHRForException(e);
    var hex = "0x" + h.ToString("X8");
    switch (h) {
      case 0x80010001: case 0x8001010A:
        return Obj("code", "busy", "message", name + " is busy (a dialog is open or a cell is being edited): try again in a moment.", "hresult", hex);
      case 0x80004004:
        return Obj("code", "not-allowed", "message", name + " refused: its programmatic access guard blocked the call (Trust Center, or an administrator's policy).", "hresult", hex);
      case 0x800401E3: case 0x800706BA: case 0x80010108:
        return Obj("code", "not-running", "message", name + " is not open.", "hresult", hex);
      case 0x80020006:
        return Obj("code", "failed", "message", name + " has no such member: " + e.Message, "hresult", hex);
    }
    return Obj("code", "failed", "message", name + " answered: " + e.Message, "hresult", hex);
  }
}

#region Render (SLD2: Office as a renderer)
// ---- Office as a renderer (docs/agents/work-office.md "Office as a renderer"): a copy of a file, sent here in
// chunks into a job folder of the helper's own, opened read only with no window, drawn by Word, Excel or
// PowerPoint themselves (a PDF, one slide as a PNG, the deck as a video), closed, and read back in chunks.
// The host never names a path on this PC: the folder and its two file names are the helper's.
//   render.begin {app, ext}                         -> {job}
//   render.put   {job, offset, data}                (base64, in order)
//   render.run   {job, to, start, slide?, width?, seconds?, height?} -> {pages?, width?, height?, seconds?, bytes}
//   render.get   {job, offset, length}              -> {data, size}
//   render.end   {job}
// `start` lets it start the app, hidden, when none runs (the box's Windows VM, nobody's desktop); without it an app
// that is not open is refused, as the other verbs refuse it. An app that turns a call away (a dialog open) is `busy`.
public class Render {
  readonly ICom com;
  public Render(ICom com) { this.com = com; }

  public static bool Has(string verb) { return verb.StartsWith("render."); }

  class Job { public string Dir, App, Ext; public long Size; }
  readonly Dictionary<string, Job> jobs = new Dictionary<string, Job>();
  public const int ChunkMax = 4 * 1024 * 1024;
  public const long InputMax = 512L * 1024 * 1024;
  const int VideoMaxMs = 15 * 60 * 1000;
  // The longest video drawn: past it the encode would outrun VideoMaxMs on the VM.
  public const int VideoMaxSeconds = 30 * 60;
  static readonly Dictionary<string, string> EXT_OF = new Dictionary<string, string> { { "word", "docx" }, { "excel", "xlsx" }, { "powerpoint", "pptx" } };

  public static string Short(string app) { return app == "word" ? "Word" : app == "excel" ? "Excel" : "PowerPoint"; }
  static string ProgId(string app) { return app == "word" ? "Word.Application" : app == "excel" ? "Excel.Application" : "PowerPoint.Application"; }
  static string Proc(string app) { return app == "word" ? "WINWORD" : app == "excel" ? "EXCEL" : "POWERPNT"; }
  static readonly object Missing = System.Reflection.Missing.Value;

  public static string Root() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TempCode", "render"); }

  static int Int(Dictionary<string, object> a, string key, int fallback, int min, int max) {
    if (!a.ContainsKey(key) || a[key] == null) return fallback;
    int v;
    try { v = Convert.ToInt32(a[key], CultureInfo.InvariantCulture); } catch (Exception) { throw new Refusal("failed", key + " is not a whole number."); }
    if (v < min || v > max) throw new Refusal("failed", key + " must be from " + min + " to " + max + ".");
    return v;
  }

  Job JobOf(object raw) {
    var id = raw as string;
    Job j;
    if (id == null || id.Length != 32 || !jobs.TryGetValue(id, out j)) throw new Refusal("not-found", "No such render job.");
    return j;
  }

  public object Run(string verb, Dictionary<string, object> a) {
    switch (verb) {
      case "render.begin": return Begin(a["app"] as string, a["ext"] as string);
      case "render.put": return Put(JobOf(a["job"]), Convert.ToInt64(a["offset"], CultureInfo.InvariantCulture), (string)a["data"]);
      case "render.run": return Draw(JobOf(a["job"]), a);
      case "render.get": return Get(JobOf(a["job"]), Convert.ToInt64(a["offset"], CultureInfo.InvariantCulture), Int(a, "length", ChunkMax, 1, ChunkMax));
      case "render.end": return End(a["job"] as string);
    }
    throw new Refusal("failed", "tc-office has no verb " + verb + ".");
  }

  object Begin(string app, string ext) {
    string want;
    if (app == null || !EXT_OF.TryGetValue(app, out want) || ext != want) throw new Refusal("failed", "Office renders a .docx in Word, a .xlsx in Excel and a .pptx in PowerPoint.");
    Sweep();
    EndOrphans();
    var id = Guid.NewGuid().ToString("N");
    var dir = Path.Combine(Root(), id);
    Directory.CreateDirectory(dir);
    jobs[id] = new Job { Dir = dir, App = app, Ext = ext };
    return Obj("job", id);
  }

  // A job folder left by a helper that stopped mid-job goes after a day.
  static void Sweep() {
    try {
      if (!Directory.Exists(Root())) return;
      foreach (var d in Directory.GetDirectories(Root())) {
        try { if (DateTime.UtcNow - Directory.GetLastWriteTimeUtc(d) > TimeSpan.FromDays(1)) Directory.Delete(d, true); } catch (Exception) { }
      }
    } catch (Exception) { }
  }

  object Put(Job j, long offset, string data) {
    var bytes = Convert.FromBase64String(data);
    if (bytes.Length > ChunkMax) throw new Refusal("failed", "A chunk is at most 4 MB.");
    if (offset != j.Size) throw new Refusal("failed", "The copy's chunks came out of order.");
    if (j.Size + bytes.Length > InputMax) throw new Refusal("failed", "Office renders a file of at most 512 MB.");
    using (var f = new FileStream(Path.Combine(j.Dir, "input." + j.Ext), FileMode.Append, FileAccess.Write)) f.Write(bytes, 0, bytes.Length);
    j.Size += bytes.Length;
    return null;
  }

  object Get(Job j, long offset, int length) {
    var path = OutputOf(j);
    if (path == null) throw new Refusal("not-found", "The render has no output yet.");
    using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
      if (offset < 0 || offset > f.Length) throw new Refusal("failed", "Past the end of the output.");
      f.Position = offset;
      var buf = new byte[(int)Math.Min(length, f.Length - offset)];
      var n = 0;
      while (n < buf.Length) { var r = f.Read(buf, n, buf.Length - n); if (r <= 0) break; n += r; }
      return Obj("data", Convert.ToBase64String(buf, 0, n), "size", f.Length);
    }
  }

  static string OutputOf(Job j) {
    foreach (var ext in new[] { "pdf", "png", "mp4" }) { var p = Path.Combine(j.Dir, "output." + ext); if (File.Exists(p)) return p; }
    return null;
  }

  object End(string id) {
    Job j;
    if (id != null && jobs.TryGetValue(id, out j)) {
      jobs.Remove(id);
      try { Directory.Delete(j.Dir, true); } catch (Exception) { }
    }
    return null;
  }

  // ---- drawing: the app's own export of the copy, which is closed after whatever happens.
  object Draw(Job j, Dictionary<string, object> a) {
    var to = a["to"] as string;
    var start = a.ContainsKey("start") && Convert.ToBoolean(a["start"]);
    if (!(to == "pdf" || (j.App == "powerpoint" && (to == "png" || to == "mp4")))) throw new Refusal("failed", Short(j.App) + " does not render a ." + to + " here.");
    var input = Path.Combine(j.Dir, "input." + j.Ext);
    if (!File.Exists(input) || j.Size == 0) throw new Refusal("failed", "The copy did not arrive.");
    var old = OutputOf(j);
    if (old != null) File.Delete(old);
    var output = Path.Combine(j.Dir, "output." + to);
    // A password-locked file is an OLE compound file where a .docx, .xlsx or .pptx is a zip: its app would ask for the
    // password in a dialog, inside Open, and every Office call here would wait behind it. Refused before any app.
    if (Locked(input)) throw new Refusal("refused", LockedWords(j.App));
    bool mine;
    int pid;
    object alerts = null;
    var app = Attach(j.App, start, out mine, out pid);
    // A PowerPoint someone else started takes no alert from this job either, while it runs (the VM only).
    if (start && !mine && j.App == "powerpoint") { try { alerts = com.Get(app, "DisplayAlerts"); com.Set(app, "DisplayAlerts", 1); } catch (COMException) { alerts = null; } }
    try {
      Dictionary<string, object> done;
      if (j.App == "word") done = Word(app, input, output, mine);
      else if (j.App == "excel") done = Excel(app, input, output, mine);
      else done = PowerPoint(app, input, output, to, a);
      if (!File.Exists(output)) throw new Refusal("failed", Short(j.App) + " made no " + to.ToUpperInvariant() + ".");
      done["bytes"] = new FileInfo(output).Length;
      return done;
    } catch (COMException e) {
      if (Office.Busy(e)) throw new Refusal("busy", Short(j.App) + " is busy with a dialog: try again once it is closed.");
      throw new Refusal("failed", Short(j.App) + " could not render the copy: " + e.Message);
    } finally {
      if (alerts != null) { try { com.Set(app, "DisplayAlerts", alerts); } catch (Exception) { } }
      // An app this job started is ended whatever happened: quit, and its process ended if Quit did not end it (a
      // dialog, a video still exporting). With `start` (the VM), an app left hidden with no file open is nobody's,
      // whoever started it, and is quit (never ended).
      if (mine) End(j.App, app, pid);
      else { if (start && Unseen(j.App, app)) Quit(j.App, app); com.Release(app); }
    }
  }

  public static string LockedWords(string app) { return "This file is locked with a password; open it in " + Short(app) + " to check it."; }
  static readonly byte[] CFB = { 0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1 };
  public static bool Locked(string path) {
    var head = new byte[8];
    using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) { if (f.Read(head, 0, 8) < 8) return false; }
    for (var i = 0; i < 8; i++) if (head[i] != CFB[i]) return false;
    return true;
  }

  // ---- what this helper started: kept by process id in a file, so a helper stopped mid-job (a stall, the
  // box's restart of it) leaves nothing the next helper cannot end.
  static string StartedFile() { return Path.Combine(Root(), "started.txt"); }
  public static void Remember(int pid, string identity) {
    Directory.CreateDirectory(Root());
    File.AppendAllText(StartedFile(), pid + "\t" + identity + "\r\n");
  }
  static void Forget(int pid) {
    try {
      if (!File.Exists(StartedFile())) return;
      var keep = new List<string>();
      foreach (var line in File.ReadAllLines(StartedFile())) if (!line.StartsWith(pid + "\t")) keep.Add(line);
      if (keep.Count == 0) File.Delete(StartedFile()); else File.WriteAllLines(StartedFile(), keep.ToArray());
    } catch (Exception) { }
  }
  // Each app still running that a stopped helper started (the same process: its name and start time) is ended.
  void EndOrphans() {
    try {
      if (!File.Exists(StartedFile())) return;
      foreach (var line in File.ReadAllLines(StartedFile())) {
        var parts = line.Split('\t');
        int pid;
        if (parts.Length != 2 || !int.TryParse(parts[0], out pid)) continue;
        if (com.Identity(pid) == parts[1]) { Console.Error.WriteLine("tc-office: ending an app a stopped render left: " + parts[1]); com.Kill(pid); }
      }
      File.Delete(StartedFile());
    } catch (Exception x) { Console.Error.WriteLine("tc-office: the apps a stopped render left: " + x.Message); }
  }

  // Quits the app, lets go of it, and ends its process if it has not ended within ten seconds (or Quit was refused).
  void End(string app, object a, int pid) {
    var quit = Quit(app, a);
    // No reference of ours may keep it alive while it quits: the app, and whatever of it the collector still holds.
    com.Release(a);
    GC.Collect();
    GC.WaitForPendingFinalizers();
    GC.Collect();
    if (pid == 0) return;
    var identity = com.Identity(pid);
    // Quit asked: give the process ten seconds to end by itself (PowerPoint takes a few).
    for (var waited = 0; quit && identity != null && waited < 10000; waited += 200) { Thread.Sleep(200); identity = com.Identity(pid); }
    if (identity != null) { Console.Error.WriteLine("tc-office: " + Short(app) + " did not quit: ending it"); com.Kill(pid); }
    Forget(pid);
  }

  bool Unseen(string app, object a) {
    try {
      var files = com.Get(a, app == "word" ? "Documents" : app == "excel" ? "Workbooks" : "Presentations");
      return Convert.ToInt32(com.Get(files, "Count")) == 0 && !Convert.ToBoolean(com.Get(a, "Visible"));
    } catch (Exception) { return false; }
  }

  // The running app, or with `start` one of our own, hidden. Excel and Word with `start` are always our own (both run
  // one process per instance): a workbook opened in his Excel would take a window in front of him, and a Word someone
  // else runs has its alerts on. PowerPoint is one app per session, so with `start` a running one is used.
  object Attach(string app, bool start, out bool mine, out int pid) {
    mine = false;
    pid = 0;
    if (!com.Registered(ProgId(app))) throw new Refusal("not-installed", "No " + Short(app) + " is in reach: it is not installed on this PC.");
    var running = com.Running(Proc(app));
    if (running && !(start && app != "powerpoint")) {
      try { return com.Active(ProgId(app)); }
      catch (COMException e) {
        if (Office.Busy(e)) throw new Refusal("busy", Short(app) + " is busy with a dialog: try again once it is closed.");
        if ((uint)e.ErrorCode != 0x800401E3 || !start) throw new Refusal("not-running", Short(app) + " is open but not reachable: it may be starting.");
      }
    }
    if (!start) throw new Refusal("not-running", Short(app) + " is not open on this PC.");
    var before = com.Pids(Proc(app));
    var made = com.Create(ProgId(app));
    // The process it started, by the ids before and after: kept, so it is ended whatever happens to the job.
    foreach (var id in com.Pids(Proc(app))) if (!before.Contains(id)) { pid = id; break; }
    if (pid != 0) { var identity = com.Identity(pid); if (identity != null) Remember(pid, identity); else pid = 0; }
    // PowerPoint is one app per session: a create while it runs is the running one, not ours to quit.
    mine = !(app == "powerpoint" && running);
    // No alert of any app of our own raises a dialog (wdAlertsNone, false, ppAlertsNone).
    if (mine) { try { com.Set(made, "DisplayAlerts", app == "word" ? (object)0 : app == "excel" ? (object)false : 1); } catch (COMException) { } }
    // No macro of the copy runs: msoAutomationSecurityForceDisable, on an app of our own only.
    if (mine) { try { com.Set(made, "AutomationSecurity", 3); } catch (COMException) { } }
    return made;
  }

  // True when Quit was asked and taken; a PowerPoint still holding a deck is not asked.
  bool Quit(string app, object a) {
    try {
      if (app == "powerpoint") { if (Convert.ToInt32(com.Get(com.Get(a, "Presentations"), "Count")) != 0) return false; com.Call(a, "Quit"); }
      else if (app == "word") com.Call(a, "Quit", 0);
      else com.Call(a, "Quit");
      return true;
    } catch (Exception x) { Console.Error.WriteLine("tc-office: quitting " + app + ": " + x.Message); return false; }
  }

  // A password the copy cannot have: an encrypted file then fails at once instead of asking in a dialog.
  const string NoPassword = "tc-office-no-password";

  Dictionary<string, object> Word(object w, string input, string output, bool mine) {
    // Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate, Revert,
    //      WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible, OpenAndRepair, DocumentDirection, NoEncodingDialog)
    var d = com.Call(com.Get(w, "Documents"), "Open", input, false, true, false, NoPassword, NoPassword, false, NoPassword, NoPassword, Missing, Missing, false, false, Missing, true);
    try {
      // wdStatisticPages, as Word counts them for this copy
      var pages = Convert.ToInt32(com.Call(d, "ComputeStatistics", 2));
      // ExportAsFixedFormat(OutputFileName, wdExportFormatPDF, OpenAfterExport, wdExportOptimizeForPrint, wdExportAllDocument,
      //      From, To, wdExportDocumentContent, IncludeDocProps, KeepIRM, wdExportCreateNoBookmarks, DocStructureTags, BitmapMissingFonts, UseISO19005_1)
      com.Call(d, "ExportAsFixedFormat", output, 17, false, 0, 0, 1, 1, 0, true, true, 0, true, true, false);
      return Obj("pages", pages);
    } finally {
      try { com.Call(d, "Close", 0); } catch (Exception x) { Console.Error.WriteLine("tc-office: closing the copy: " + x.Message); }
      com.Release(d);
    }
  }

  Dictionary<string, object> Excel(object xl, string input, string output, bool mine) {
    // Open(Filename, UpdateLinks, ReadOnly, Format, Password, WriteResPassword, IgnoreReadOnlyRecommended, Origin, Delimiter,
    //      Editable, Notify, Converter, AddToMru)
    // No WriteResPassword: Excel refuses one for a workbook that has none (found in the VM, 2026-11-23), where Word ignores its own.
    var b = com.Call(com.Get(xl, "Workbooks"), "Open", input, 0, true, Missing, NoPassword, Missing, true, Missing, Missing, false, false, Missing, false);
    try {
      // In his own Excel, the copy's window is hidden at once.
      if (!mine) { try { com.Set(com.Call(com.Get(b, "Windows"), "Item", 1), "Visible", false); } catch (COMException e) { if (Office.Busy(e)) throw; } }
      var pages = 0;
      foreach (var s in Each(com.Get(b, "Sheets"))) {
        try {
          if (Convert.ToInt32(com.Get(s, "Visible")) != -1) continue;
          pages += Convert.ToInt32(com.Get(com.Get(com.Get(s, "PageSetup"), "Pages"), "Count"));
        } catch (COMException e) { if (Office.Busy(e)) throw; }
      }
      // ExportAsFixedFormat(xlTypePDF, Filename, xlQualityStandard, IncludeDocProperties, IgnorePrintAreas = false: the workbook's own print settings, From, To, OpenAfterPublish)
      com.Call(b, "ExportAsFixedFormat", 0, output, 0, true, false, Missing, Missing, false);
      return Obj("pages", pages);
    } finally {
      try { com.Call(b, "Close", false); } catch (Exception x) { Console.Error.WriteLine("tc-office: closing the copy: " + x.Message); }
      com.Release(b);
    }
  }

  Dictionary<string, object> PowerPoint(object pp, string input, string output, string to, Dictionary<string, object> a) {
    // Open(FileName, ReadOnly = msoTrue, Untitled = msoFalse, WithWindow = msoFalse)
    var p = com.Call(com.Get(pp, "Presentations"), "Open", input, -1, 0, 0);
    // A deck still exporting is not closed (Close would ask whether to stop the export, in a dialog): an app of the
    // job's own is ended with it instead (Draw's End).
    var exporting = false;
    try {
      var slides = com.Get(p, "Slides");
      var count = Convert.ToInt32(com.Get(slides, "Count"));
      if (to == "pdf") {
        // ppSaveAsPDF
        com.Call(p, "SaveAs", output, 32);
        return Obj("pages", count);
      }
      if (to == "png") {
        var n = Int(a, "slide", 1, 1, 100000);
        if (n > count) throw new Refusal("not-found", "The deck has " + count + " slide" + (count == 1 ? "" : "s") + "; there is no slide " + n + ".");
        var width = Int(a, "width", 1920, 16, 8192);
        var setup = com.Get(p, "PageSetup");
        var sw = Convert.ToDouble(com.Get(setup, "SlideWidth"), CultureInfo.InvariantCulture);
        var sh = Convert.ToDouble(com.Get(setup, "SlideHeight"), CultureInfo.InvariantCulture);
        var height = (int)Math.Max(1, Math.Round(width * sh / sw));
        com.Call(com.Call(slides, "Item", n), "Export", output, "PNG", width, height);
        return Obj("width", width, "height", height);
      }
      var seconds = Int(a, "seconds", 5, 1, 600);
      var tall = Int(a, "height", 720, 240, 2160);
      // A hidden slide is left out of the video, and so out of its length.
      var shown = 0;
      for (var i = 1; i <= count; i++) { if (Convert.ToInt32(com.Get(com.Get(com.Call(slides, "Item", i), "SlideShowTransition"), "Hidden")) != -1) shown++; }
      if (shown == 0) throw new Refusal("failed", "Every slide of the deck is hidden: the video would show nothing.");
      if (shown * seconds > VideoMaxSeconds) throw new Refusal("failed", "That video would run " + Math.Ceiling(shown * seconds / 60.0) + " minutes: Office draws one of at most " + (VideoMaxSeconds / 60) + " minutes here.");
      // CreateVideo(FileName, UseTimingsAndNarrations, DefaultSlideDuration, VertResolution, FramesPerSecond, Quality)
      com.Call(p, "CreateVideo", output, false, seconds, tall, 30, 85);
      exporting = true;
      // PpMediaTaskStatus: 1 in progress, 2 queued, 3 done, 4 failed
      var waited = 0;
      for (;;) {
        var status = Convert.ToInt32(com.Get(p, "CreateVideoStatus"));
        if (status == 3) { exporting = false; break; }
        if (status == 4) { exporting = false; throw new Refusal("failed", "PowerPoint could not make the video."); }
        if (status != 1 && status != 2) throw new Refusal("failed", "PowerPoint did not start the video.");
        if (waited >= VideoMaxMs) throw new Refusal("failed", "PowerPoint did not finish the video within 15 minutes.");
        Thread.Sleep(250);
        waited += 250;
      }
      return Obj("seconds", shown * seconds, "height", tall);
    } finally {
      if (exporting) Console.Error.WriteLine("tc-office: the video was still exporting: the copy is left open for its app's end");
      else { try { com.Call(p, "Close"); } catch (Exception x) { Console.Error.WriteLine("tc-office: closing the copy: " + x.Message); } }
      com.Release(p);
    }
  }

  IEnumerable<object> Each(object collection) {
    var n = Convert.ToInt32(com.Get(collection, "Count"));
    for (var i = 1; i <= n; i++) yield return com.Call(collection, "Item", i);
  }

  static Dictionary<string, object> Obj(params object[] kv) { return Office.Obj(kv); }
}
#endregion

#region Present (SLD9: a deck's own slideshow in PowerPoint)
// ---- Presenting in PowerPoint (docs/agents/work-office.md "Presenting in PowerPoint"): on his press alone, the
// deck in PowerPoint (opened where it is not open already; PowerPoint started and shown when it was shut), and
// PowerPoint's own slideshow of every slide, from the first, in front.
//   present.run {ref: {path} | {url}} -> {slides}
public class Present {
  readonly ICom com;
  public Present(ICom com) { this.com = com; }

  public static bool Has(string verb) { return verb == "present.run"; }

  const int ppShowAll = 1, msoTrue = -1, msoFalse = 0;

  IEnumerable<object> Each(object collection) {
    var n = Convert.ToInt32(com.Get(collection, "Count"));
    for (var i = 1; i <= n; i++) yield return com.Call(collection, "Item", i);
  }

  public object Run(string verb, Dictionary<string, object> a) {
    var r = a.ContainsKey("ref") ? a["ref"] as Dictionary<string, object> : null;
    var path = r != null && r.ContainsKey("path") ? r["path"] as string : null;
    var url = r != null && r.ContainsKey("url") ? r["url"] as string : null;
    var key = path ?? url;
    if (key == null) throw new Refusal("failed", "No deck was named.");
    if (!com.Registered("PowerPoint.Application")) throw new Refusal("not-installed", "PowerPoint is not installed on this PC.");
    // The deck as his PowerPoint has it open; else his file opened, in PowerPoint started for him and shown when it
    // was shut: this is his own press.
    object pp = null, deck = null;
    if (com.Running("POWERPNT")) {
      pp = com.Active("PowerPoint.Application");
      foreach (var d in Each(com.Get(pp, "Presentations"))) if (string.Equals((string)com.Get(d, "FullName"), key, StringComparison.OrdinalIgnoreCase)) { deck = d; break; }
    }
    if (deck == null) {
      if (path != null && !File.Exists(path)) throw new Refusal("not-found", "There is no such deck on this PC.");
      if (pp == null) pp = com.Create("PowerPoint.Application");
      try { com.Set(pp, "Visible", msoTrue); } catch (COMException) { }
      // Open(FileName, ReadOnly, Untitled, WithWindow): his own file, in a window of its own.
      deck = com.Call(com.Get(pp, "Presentations"), "Open", key, msoFalse, msoFalse, msoTrue);
    }
    var count = Convert.ToInt32(com.Get(com.Get(deck, "Slides"), "Count"));
    if (count == 0) throw new Refusal("refused", "The deck has no slides to show.");
    // Each of these writes marks the deck changed, where a show alone does not (PowerPoint 16.0): a deck he had saved
    // is marked saved again, so presenting it never asks him to save it when he closes it.
    var saved = Convert.ToInt32(com.Get(deck, "Saved")) == msoTrue;
    var settings = com.Get(deck, "SlideShowSettings");
    com.Set(settings, "RangeType", ppShowAll);
    com.Set(settings, "StartingSlide", 1);
    com.Set(settings, "EndingSlide", count);
    if (saved) com.Set(deck, "Saved", msoTrue);
    com.Call(settings, "Run");
    // The show's own window, by PowerPoint's process and its class: a SlideShowWindow has no HWND by IDispatch
    // (DISP_E_MEMBERNOTFOUND). In front, it hears his keys; the show runs either way.
    var name = Path.GetFileNameWithoutExtension((string)com.Get(deck, "Name"));
    var hwnd = 0;
    for (var i = 0; i < 10 && (hwnd = com.Window("POWERPNT", "screenClass", name)) == 0; i++) Thread.Sleep(200);
    if (hwnd != 0) com.Foreground(hwnd);
    return Office.Obj("slides", count);
  }
}
#endregion

// ---- OneDrive's folders and what is signed in, for a host that reaches this PC through the helper's
// door (the box's Windows VM: docs/agents/work-teams-files.md "The Windows VM"). No COM here: each verb runs
// on its connection's own thread, so a long download never holds an Office call. Reads run as the user
// whose desktop this is, the one caller OneDrive's Files On-Demand surely downloads for.
public static class Guest {
  const uint REPARSE = 0x400, OFFLINE = 0x1000, RECALL_ON_OPEN = 0x40000, PINNED = 0x80000, UNPINNED = 0x100000, RECALL_ON_DATA_ACCESS = 0x400000;
  const uint DIRECTORY = 0x10, HIDDEN = 0x2, SYSTEM = 0x4, INVALID = 0xFFFFFFFF;
  const uint TAG_SYMLINK = 0xA000000C, TAG_MOUNT_POINT = 0xA0000003;
  public const int ReadMax = 8 * 1024 * 1024;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FindData {
    public uint attrs;
    public uint createdLow, createdHigh, accessedLow, accessedHigh, writtenLow, writtenHigh;
    public uint sizeHigh, sizeLow, reserved0, reserved1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string alt;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindFirstFileW(string pattern, out FindData data);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool FindNextFileW(IntPtr h, out FindData data);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetFileAttributesW(string path, uint attrs);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

  public static bool Has(string verb) { return verb.StartsWith("files.") || verb.StartsWith("onedrive.") || verb.StartsWith("ui.") || verb == "guest.status" || verb == "office.start"; }

  static string Long(string path) { return path.StartsWith(@"\\?\") ? path : @"\\?\" + path; }
  static readonly DateTime EPOCH = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
  static long Ms(long fileTime) { try { return (long)(DateTime.FromFileTimeUtc(fileTime) - EPOCH).TotalMilliseconds; } catch (Exception) { return 0; } }

  static Dictionary<string, object> Entry(string dir, FindData d) {
    var isDir = (d.attrs & DIRECTORY) != 0;
    var link = (d.attrs & REPARSE) != 0 && (d.reserved0 == TAG_SYMLINK || d.reserved0 == TAG_MOUNT_POINT);
    var cloud = (d.attrs & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS)) != 0;
    return Office.Obj("name", d.name, "path", dir.TrimEnd('\\') + "\\" + d.name, "dir", isDir, "size", isDir ? 0L : ((long)d.sizeHigh << 32) | d.sizeLow,
      "modified", Ms(((long)d.writtenHigh << 32) | d.writtenLow), "local", isDir || !cloud, "link", link, "pinned", (d.attrs & PINNED) != 0);
  }

  // One folder's entries as the disk lists them: nothing is opened, so nothing downloads.
  static List<Dictionary<string, object>> Dir(string dir) {
    var list = new List<Dictionary<string, object>>();
    FindData d;
    var h = FindFirstFileW(Long(dir.TrimEnd('\\') + @"\*"), out d);
    if (h == new IntPtr(-1)) {
      var err = Marshal.GetLastWin32Error();
      if (err == 2 || err == 18) return list;
      throw new Refusal(err == 3 ? "not-found" : "failed", err == 3 ? "No folder " + dir + "." : "Windows could not list " + dir + " (error " + err + ").");
    }
    try {
      do {
        if (d.name == "." || d.name == "..") continue;
        if ((d.attrs & HIDDEN) != 0 && (d.attrs & SYSTEM) != 0) continue;
        list.Add(Entry(dir, d));
      } while (FindNextFileW(h, out d));
    } finally { FindClose(h); }
    return list;
  }

  static Dictionary<string, object> Stat(string path) {
    FindData d;
    var h = FindFirstFileW(Long(path.TrimEnd('\\')), out d);
    if (h == new IntPtr(-1)) throw new Refusal("not-found", "No file " + path + ".");
    FindClose(h);
    var at = path.TrimEnd('\\');
    var cut = at.LastIndexOf('\\');
    return Entry(at.Substring(0, cut), d);
  }

  static RegistryKey User(string path) { return Registry.CurrentUser.OpenSubKey(path); }
  static string Str(RegistryKey k, string name) { var v = k == null ? null : k.GetValue(name) as string; return string.IsNullOrEmpty(v) ? null : v; }

  // What OneDrive syncs here, from its own registry rows: his files and each library, with the web address it stands for.
  public static List<Dictionary<string, object>> Mounts() {
    var list = new List<Dictionary<string, object>>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    using (var providers = User(@"Software\SyncEngines\Providers\OneDrive")) {
      if (providers != null) foreach (var id in providers.GetSubKeyNames()) {
        using (var k = providers.OpenSubKey(id)) {
          var mount = Str(k, "MountPoint");
          var type = (Str(k, "LibraryType") ?? "").ToLowerInvariant();
          if (mount == null || type == "personal" || !Directory.Exists(mount) || !seen.Add(mount.TrimEnd('\\'))) continue;
          list.Add(Office.Obj("path", mount.TrimEnd('\\'), "type", type == "mysite" ? "mine" : "team", "web", Str(k, "UrlNamespace")));
        }
      }
    }
    // An account's own folder and its tenants' libraries, should a provider row be missing.
    using (var accounts = User(@"Software\Microsoft\OneDrive\Accounts")) {
      if (accounts != null) foreach (var name in accounts.GetSubKeyNames()) {
        if (!name.StartsWith("Business", StringComparison.OrdinalIgnoreCase)) continue;
        using (var a = accounts.OpenSubKey(name)) {
          var mine = Str(a, "UserFolder");
          if (mine != null && Directory.Exists(mine) && seen.Add(mine.TrimEnd('\\'))) list.Add(Office.Obj("path", mine.TrimEnd('\\'), "type", "mine", "web", null));
          using (var tenants = a.OpenSubKey("Tenants")) {
            if (tenants != null) foreach (var t in tenants.GetSubKeyNames()) using (var tk = tenants.OpenSubKey(t)) {
              foreach (var folder in tk.GetValueNames()) {
                if (folder.Length > 3 && folder[1] == ':' && Directory.Exists(folder) && seen.Add(folder.TrimEnd('\\'))) list.Add(Office.Obj("path", folder.TrimEnd('\\'), "type", "team", "web", null));
              }
            }
          }
        }
      }
    }
    return list;
  }

  // The mount a path lies in, by name alone: absolute, no `.` or `..`, no other separator, no stream (`:`), no
  // name Windows keeps for a device; null when it is in none.
  static string MountOf(string path) {
    if (path == null || path.Length < 3 || path[1] != ':' || path[2] != '\\' || path.IndexOf('/') >= 0) return null;
    foreach (var part in path.Substring(3).Split('\\')) if (part == "." || part == ".." || part.EndsWith(" ") || (part.EndsWith(".") && part.Length > 0) || (part.Length > 0 && NameProblem(part) != null)) return null;
    foreach (var m in Mounts()) {
      var root = (string)m["path"];
      if (path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase)) return root;
    }
    return null;
  }

  // A path inside OneDrive's folders, with no link on the way down (a cloud placeholder is a reparse point too, and is none).
  static string Admit(object raw) {
    var path = (raw as string ?? "").TrimEnd('\\');
    var root = MountOf(path);
    if (root == null) throw new Refusal("not-allowed", "That is not in a folder OneDrive syncs on this PC.");
    var at = root;
    foreach (var part in path.Substring(root.Length).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries)) {
      at = at + "\\" + part;
      FindData d;
      var h = FindFirstFileW(Long(at), out d);
      if (h == new IntPtr(-1)) throw new Refusal("not-found", "No file " + path + ".");
      FindClose(h);
      if ((d.attrs & REPARSE) != 0 && (d.reserved0 == TAG_SYMLINK || d.reserved0 == TAG_MOUNT_POINT)) throw new Refusal("not-allowed", "That path leaves OneDrive's folder through a link.");
    }
    return path;
  }

  static FileStream OpenRead(string path) {
    // read, shared with everything, sequential
    var h = CreateFileW(Long(path), 0x80000000, 7, IntPtr.Zero, 3, 0x08000000, IntPtr.Zero);
    if (h.IsInvalid) {
      var err = Marshal.GetLastWin32Error();
      throw new Refusal(err == 2 || err == 3 ? "not-found" : "failed", "Windows could not open " + path + " (error " + err + (err == 362 || err == 395 || err == 404 ? ": OneDrive is not running or could not download it" : "") + ").");
    }
    return new FileStream(h, FileAccess.Read, 1 << 20);
  }

  static object Read(string path, long offset, int length) {
    if (length < 0 || length > ReadMax) length = ReadMax;
    using (var f = OpenRead(path)) {
      var size = f.Length;
      if (offset > size) offset = size;
      f.Seek(offset, SeekOrigin.Begin);
      var buf = new byte[(int)Math.Min(length, size - offset)];
      var got = 0;
      while (got < buf.Length) {
        var n = f.Read(buf, got, buf.Length - got);
        if (n <= 0) break;
        got += n;
      }
      return Office.Obj("data", Convert.ToBase64String(buf, 0, got), "size", size, "eof", offset + got >= size);
    }
  }

  // Reads the file to its end, which makes OneDrive download one it keeps in the cloud.
  static object Fetch(string path) {
    using (var f = OpenRead(path)) {
      var buf = new byte[1 << 20];
      while (f.Read(buf, 0, buf.Length) > 0) { }
    }
    return Stat(path);
  }

  // Free up space: the file goes back to the cloud, as Explorer's own command does it. One he pinned is left.
  static object Free(string path) {
    var a = GetFileAttributesW(Long(path));
    if (a == INVALID || (a & DIRECTORY) != 0 || (a & PINNED) != 0) return false;
    if ((a & (OFFLINE | RECALL_ON_DATA_ACCESS)) != 0) return true;
    return SetFileAttributesW(Long(path), a | UNPINNED);
  }

  static object Search(Dictionary<string, object> a) {
    var words = new List<string>();
    foreach (var w in (ArrayList)a["words"]) words.Add(((string)w).ToLowerInvariant());
    var only = a.ContainsKey("only") ? (string)a["only"] : "any";
    var exts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    if (a.ContainsKey("exts")) foreach (var e in (ArrayList)a["exts"]) exts.Add((string)e);
    int maxDirs = Convert.ToInt32(a["maxDirs"]), maxHits = Convert.ToInt32(a["maxHits"]);
    var until = DateTime.UtcNow.AddMilliseconds(Convert.ToInt32(a["ms"]));
    var hits = new List<object>();
    var more = false;
    var dirs = 0;
    foreach (var r in (ArrayList)a["roots"]) {
      var root = Admit(r);
      var queue = new Queue<string>();
      queue.Enqueue(root);
      while (queue.Count > 0) {
        if (++dirs > maxDirs || hits.Count >= maxHits || DateTime.UtcNow > until) { more = true; break; }
        List<Dictionary<string, object>> items;
        try { items = Dir(queue.Dequeue()); } catch (Refusal) { continue; }
        foreach (var e in items) {
          var name = (string)e["name"];
          if ((bool)e["link"] || name.StartsWith(".") || name.StartsWith("~$") || name.EndsWith(".tmp")) continue;
          var isDir = (bool)e["dir"];
          if (isDir) queue.Enqueue((string)e["path"]);
          var lower = name.ToLowerInvariant();
          var all = true;
          foreach (var w in words) if (lower.IndexOf(w, StringComparison.Ordinal) < 0) { all = false; break; }
          if (!all) continue;
          var dot = name.LastIndexOf('.');
          var ext = dot > 0 ? name.Substring(dot + 1) : "";
          if (only == "folder" ? !isDir : only == "exts" ? isDir || !exts.Contains(ext) : only == "other" ? isDir || exts.Contains(ext) : false) continue;
          e["root"] = root;
          hits.Add(e);
        }
      }
      if (more) break;
    }
    return Office.Obj("hits", hits, "more", more);
  }

  // ---- Changes: New, rename, move, write and the Recycle Bin (docs/agents/work-teams-files.md "The Windows VM"). Each
  // is held to OneDrive's mounts at both ends (Admit, and the parent folder held open while its real path is checked),
  // never writes over anything but a file `files.write` names by its version, and runs under its operation id: the
  // same id again answers what the first did and does nothing twice (Journalled).

  // What this helper changes; the host offers a verb only where the helper lists it (`guest.status`'s `verbs`).
  public static readonly string[] Changes = { "files.mkdir", "files.rename", "files.move", "files.write", "files.recycle", "files.restore", "files.outcome" };
  public const int WriteMax = 16 * 1024 * 1024;
  const long HashMax = 64L * 1024 * 1024;

  static readonly System.Text.RegularExpressions.Regex Reserved = new System.Text.RegularExpressions.Regex(@"^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

  // Why NTFS or OneDrive would not take `name` as one part of a path, or null.
  public static string NameProblem(string name) {
    if (string.IsNullOrEmpty(name) || name.Trim().Length == 0) return "A name needs at least one letter.";
    if (name.Length > 255) return "A name can be 255 characters at most.";
    if (name == "." || name == "..") return "That name is not allowed.";
    foreach (var c in name) if (c < 32 || c == 127 || "<>:\"/\\|?*".IndexOf(c) >= 0) return "A name cannot hold " + (c < 32 || c == 127 ? "a control character" : c.ToString()) + ".";
    if (name.EndsWith(" ") || name.EndsWith(".") || name.StartsWith(" ")) return "A name cannot start with a space or end with a space or a dot.";
    if (Reserved.IsMatch(name)) return "Windows keeps that name for itself.";
    if (name.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase) || name.IndexOf("_vti_", StringComparison.OrdinalIgnoreCase) >= 0) return "OneDrive does not take that name.";
    return null;
  }
  static void Name(string name) { var p = NameProblem(name); if (p != null) throw new Refusal("refused", p); }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(Microsoft.Win32.SafeHandles.SafeFileHandle h, StringBuilder buf, uint len, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateDirectoryW(string path, IntPtr security);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool MoveFileExW(string from, string to, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ReplaceFileW(string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeleteFileW(string path);
  const uint MOVEFILE_WRITE_THROUGH = 8, REPLACEFILE_IGNORE_MERGE_ERRORS = 2;

  // A folder's real path, from a handle on it (the volume's own spelling, every link resolved).
  static string FinalOf(Microsoft.Win32.SafeHandles.SafeFileHandle h) {
    var buf = new StringBuilder(1024);
    var n = GetFinalPathNameByHandleW(h, buf, (uint)buf.Capacity, 0);
    if (n == 0 || n >= buf.Capacity) throw new Refusal("failed", "Windows could not say where a folder is (error " + Marshal.GetLastWin32Error() + ").");
    return buf.ToString().TrimEnd('\\');
  }

  // A folder opened as itself (a link is not followed), held against being renamed or deleted while a change runs in it.
  // Something that holds it for its own delete (a sync engine) leaves it shared; then its real path is checked after too.
  static Microsoft.Win32.SafeHandles.SafeFileHandle OpenFolder(string dir, bool shareDelete) {
    // FILE_LIST_DIRECTORY, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
    return CreateFileW(Long(dir), 1, shareDelete ? 7u : 3u, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
  }

  public sealed class Held : IDisposable {
    readonly Microsoft.Win32.SafeHandles.SafeFileHandle h;
    readonly string root, dir;
    readonly bool shared;
    public Held(string dir) {
      this.dir = dir;
      var mount = MountOf(dir);
      if (mount == null) throw new Refusal("not-allowed", "That is not in a folder OneDrive syncs on this PC.");
      using (var m = OpenFolder(mount, true)) {
        if (m.IsInvalid) throw new Refusal("not-found", "No folder " + mount + ".");
        root = FinalOf(m);
      }
      h = OpenFolder(dir, false);
      if (h.IsInvalid && Marshal.GetLastWin32Error() == 32) { h = OpenFolder(dir, true); shared = true; }
      if (h.IsInvalid) {
        var err = Marshal.GetLastWin32Error();
        throw new Refusal(err == 2 || err == 3 ? "not-found" : "failed", err == 2 || err == 3 ? "No folder " + dir + "." : "Windows could not open " + dir + " (error " + err + ").");
      }
      Check();
    }
    // The folder's real path still lies in its mount: a folder swapped for a link, or moved out, is caught here.
    public void Check() {
      var at = FinalOf(h);
      if (!(at.Equals(root, StringComparison.OrdinalIgnoreCase) || at.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase)))
        throw new Refusal("not-allowed", "That folder now lies outside OneDrive's folder, so nothing was changed in it.");
    }
    public bool Shared { get { return shared; } }
    public void Dispose() { h.Dispose(); }
  }

  static string ParentOf(string path) { var cut = path.LastIndexOf('\\'); return cut <= 2 ? path.Substring(0, 3) : path.Substring(0, cut); }
  static string BaseOf(string path) { return path.Substring(path.LastIndexOf('\\') + 1); }
  static bool IsDir(string path) { var a = GetFileAttributesW(Long(path)); return a != INVALID && (a & DIRECTORY) != 0; }
  static bool Within(string path, string dir) { return path.Equals(dir, StringComparison.OrdinalIgnoreCase) || path.StartsWith(dir + "\\", StringComparison.OrdinalIgnoreCase); }

  static Exception Failed(string what, string name) { return Failed(what, name, Marshal.GetLastWin32Error()); }
  static Exception Failed(string what, string name, int err) {
    if (err == 80 || err == 183) return new Refusal("refused", "A " + (IsDir(name) ? "folder" : "file") + " named \"" + BaseOf(name) + "\" is already there.");
    if (err == 2 || err == 3) return new Refusal("not-found", BaseOf(name) + " is not there any more.");
    if (err == 32 || err == 33) return new Refusal("busy", BaseOf(name) + " is open somewhere. Close it and try again.");
    if (err == 5) return new Refusal("not-allowed", "Windows did not let tc-office " + what + " " + BaseOf(name) + ".");
    return new Refusal("failed", "Windows could not " + what + " " + BaseOf(name) + " (error " + err + ").");
  }

  // A thing that is no mount's own top: the place itself is never renamed, moved or deleted.
  static string Inner(object raw) {
    var path = Admit(raw);
    if (path.Equals(MountOf(path), StringComparison.OrdinalIgnoreCase)) throw new Refusal("refused", "A place itself cannot be renamed, moved or deleted.");
    return path;
  }

  // A file's version as the host's `versionWord` spells one: its size, its change time and, up to 64 MB, its sha256.
  public static string VersionOf(string path, out long changed) {
    var e = Stat(path);
    if ((bool)e["dir"]) throw new Refusal("refused", "That is a folder, not a file.");
    var size = (long)e["size"];
    changed = (long)e["modified"];
    var hash = "";
    if (size <= HashMax) using (var f = OpenRead(path)) using (var sha = System.Security.Cryptography.SHA256.Create()) {
      var sb = new StringBuilder(64);
      foreach (var b in sha.ComputeHash(f)) sb.Append(b.ToString("x2"));
      hash = sb.ToString();
    }
    return size + ":" + changed + ":" + hash;
  }

  // Bytes into a new hidden file beside where they go, written through to the disk. Answers its path.
  static string Staged(string dir, string name, byte[] data) {
    var temp = dir + "\\." + name + "." + Guid.NewGuid().ToString("N").Substring(0, 12) + ".tmp";
    // GENERIC_WRITE, no sharing, CREATE_NEW, FILE_ATTRIBUTE_HIDDEN | FILE_FLAG_WRITE_THROUGH
    var h = CreateFileW(Long(temp), 0x40000000, 0, IntPtr.Zero, 1, 0x2 | 0x80000000, IntPtr.Zero);
    if (h.IsInvalid) throw Failed("write in", dir + "\\" + name);
    try {
      using (var f = new FileStream(h, FileAccess.Write)) { f.Write(data, 0, data.Length); f.Flush(true); }
    } catch (Exception) { DeleteFileW(Long(temp)); throw; }
    return temp;
  }

  static byte[] DataOf(Dictionary<string, object> a) {
    var data = Convert.FromBase64String(a.ContainsKey("data") && a["data"] != null ? (string)a["data"] : "");
    if (data.Length > WriteMax) throw new Refusal("refused", "That is over " + (WriteMax / 1024 / 1024) + " MB, too big to write from here.");
    return data;
  }

  static object Mkdir(Dictionary<string, object> a) {
    var dir = Admit(a["dir"]);
    var name = (string)a["name"];
    Name(name);
    var to = dir + "\\" + name;
    using (var held = new Held(dir)) {
      if (!CreateDirectoryW(Long(to), IntPtr.Zero)) throw Failed("make", to);
      held.Check();
    }
    return Office.Obj("entry", Stat(to));
  }

  static object Rename(Dictionary<string, object> a) {
    var path = Inner(a["path"]);
    var name = (string)a["name"];
    Name(name);
    var dir = ParentOf(path);
    var to = dir + "\\" + name;
    if (to == path) return Office.Obj("entry", Stat(to));
    using (var held = new Held(dir)) {
      if (!MoveFileExW(Long(path), Long(to), MOVEFILE_WRITE_THROUGH)) throw Failed("rename", to.Equals(path, StringComparison.OrdinalIgnoreCase) ? path : to);
      held.Check();
    }
    return Office.Obj("entry", Stat(to));
  }

  static object Move(Dictionary<string, object> a) {
    var path = Inner(a["path"]);
    var dir = Admit(a["dir"]);
    if (!IsDir(dir)) throw new Refusal("refused", "That is a file, not a folder.");
    if (!MountOf(path).Equals(MountOf(dir), StringComparison.OrdinalIgnoreCase)) throw new Refusal("refused", "Files move within one library here.");
    if (Within(dir, path)) throw new Refusal("refused", "A folder cannot go inside itself.");
    var to = dir + "\\" + BaseOf(path);
    if (to.Equals(path, StringComparison.OrdinalIgnoreCase)) return Office.Obj("entry", Stat(path));
    using (var from = new Held(ParentOf(path)))
    using (var into = new Held(dir)) {
      if (!MoveFileExW(Long(path), Long(to), MOVEFILE_WRITE_THROUGH)) { var err = Marshal.GetLastWin32Error(); throw Failed("move", err == 80 || err == 183 ? to : path, err); }
      from.Check();
      into.Check();
    }
    return Office.Obj("entry", Stat(to));
  }

  // `{path, data, expect}` replaces a file's bytes while it is still the version `expect` names, beside and then over it
  // (ReplaceFile keeps the file's identity, so OneDrive keeps it as one file with a new version); otherwise the answer is
  // the conflict, as the host's save answers one. `{dir, name, data}` makes a new file, never over anything.
  static object Write(Dictionary<string, object> a) {
    var data = DataOf(a);
    if (a.ContainsKey("dir")) {
      var dir = Admit(a["dir"]);
      var name = (string)a["name"];
      Name(name);
      var to = dir + "\\" + name;
      using (var held = new Held(dir)) {
        var temp = Staged(dir, name, data);
        if (!MoveFileExW(Long(temp), Long(to), MOVEFILE_WRITE_THROUGH)) { var e = Failed("make", to); DeleteFileW(Long(temp)); throw e; }
        // The staged file was hidden while it was written; the new file is not.
        var made = GetFileAttributesW(Long(to));
        if (made != INVALID && (made & HIDDEN) != 0) SetFileAttributesW(Long(to), made & ~HIDDEN);
        held.Check();
      }
      return Office.Obj("entry", Stat(to));
    }
    string path;
    try { path = Inner(a["path"]); } catch (Refusal r) { if (r.Code == "not-found") return Office.Obj("conflict", Office.Obj("gone", true)); throw; }
    var expect = (string)a["expect"];
    long changed;
    var before = VersionOf(path, out changed);
    if (before != expect) return Office.Obj("conflict", Office.Obj("version", before, "changed", changed));
    var parent = ParentOf(path);
    using (var held = new Held(parent)) {
      var temp = Staged(parent, BaseOf(path), data);
      try {
        // Looked at once more just before it is replaced: a writer that came while ours was written wins.
        long now;
        var last = (string)null;
        try { last = VersionOf(path, out now); } catch (Refusal) { return Office.Obj("conflict", Office.Obj("gone", true)); }
        if (last != before) return Office.Obj("conflict", Office.Obj("version", last, "changed", now));
        if (!ReplaceFileW(Long(path), Long(temp), null, REPLACEFILE_IGNORE_MERGE_ERRORS, IntPtr.Zero, IntPtr.Zero)) throw Failed("write", path);
        held.Check();
      } finally { DeleteFileW(Long(temp)); }
    }
    long after;
    var version = VersionOf(path, out after);
    return Office.Obj("version", version, "changed", after, "entry", Stat(path));
  }

  // To the Windows Recycle Bin, never deleted for good: Windows' own file operation, asked to recycle and refused
  // before anything happens where it would delete the thing outright instead (RecycleBin.Send).
  static object Recycle(Dictionary<string, object> a) {
    var path = Inner(a["path"]);
    var name = BaseOf(path);
    string bin;
    using (var held = new Held(ParentOf(path))) {
      bin = RecycleBin.Send(path);
      held.Check();
    }
    return Office.Obj("name", name, "bin", bin);
  }

  // Put back: a thing `files.recycle` sent to the Recycle Bin (`bin`, where it said it lies there) goes back to the
  // folder it was in (`to`, the path it had), under its own name or the first free "Name (restored)", never over
  // anything and never across drives. The bin's own record of it ($I beside $R) must name `to`, so nothing else in
  // the bin is taken out; the record goes once the thing is back, as Explorer's Restore does.
  static object Restore(Dictionary<string, object> a) {
    var bin = (a["bin"] as string ?? "").TrimEnd('\\');
    var to = (a["to"] as string ?? "").TrimEnd('\\');
    var inBin = BaseOf(bin);
    var binDir = ParentOf(bin);
    if (!inBin.StartsWith("$R", StringComparison.OrdinalIgnoreCase) || binDir.IndexOf("\\$Recycle.Bin\\", StringComparison.OrdinalIgnoreCase) < 0) throw new Refusal("refused", "That is not a thing in the Recycle Bin.");
    var record = binDir + "\\$I" + inBin.Substring(2);
    string was;
    try { was = OriginalOf(File.ReadAllBytes(record)); } catch (Exception) { throw new Refusal("not-found", "That is not in the Recycle Bin any more."); }
    if (!was.TrimEnd('\\').Equals(to, StringComparison.OrdinalIgnoreCase)) throw new Refusal("refused", "The Recycle Bin holds something else there, so nothing was put back.");
    if (GetFileAttributesW(Long(bin)) == INVALID) throw new Refusal("not-found", "That is not in the Recycle Bin any more.");
    var dir = ParentOf(to);
    if (!IsDir(dir)) throw new Refusal("not-found", "The folder it was in is gone. Put it back from the Recycle Bin.");
    dir = Admit(dir);
    var name = BaseOf(to);
    using (var held = new Held(dir)) {
      for (var i = 0; i < 20; i++) {
        var at = dir + "\\" + (i == 0 ? name : RestoredName(name, i));
        if (MoveFileExW(Long(bin), Long(at), MOVEFILE_WRITE_THROUGH)) {
          held.Check();
          DeleteFileW(Long(record));
          return Office.Obj("entry", Stat(at));
        }
        var err = Marshal.GetLastWin32Error();
        if (err != 80 && err != 183) throw Failed("put back", bin, err);
      }
    }
    throw new Refusal("refused", "Too many things named like " + name + " are there already.");
  }
  // "Plan.txt" put back beside one of its name: "Plan (restored).txt", then "Plan (restored) 2.txt", as the host's freeName.
  static string RestoredName(string name, int i) {
    var dot = name.LastIndexOf('.');
    var stem = dot > 0 ? name.Substring(0, dot) : name;
    return stem + " (restored)" + (i > 1 ? " " + i : "") + (dot > 0 ? name.Substring(dot) : "");
  }
  // The path a $I record says its thing had: version 2 (Windows 10 and later) a counted string at 24, version 1 a fixed one.
  public static string OriginalOf(byte[] b) {
    var v = BitConverter.ToInt64(b, 0);
    if (v == 2) return Encoding.Unicode.GetString(b, 28, Math.Max(0, (BitConverter.ToInt32(b, 24) - 1) * 2));
    if (v == 1) return Encoding.Unicode.GetString(b, 24, Math.Min(520, b.Length - 24)).TrimEnd('\0');
    throw new Refusal("failed", "The Recycle Bin's record is of a kind tc-office does not read.");
  }

  // ---- The journal: one small file per operation id under %LOCALAPPDATA%\tc-office\ops, named by the id's hash.
  static readonly object changing = new object();
  static DateTime pruned = DateTime.MinValue;

  static string OpsDir() {
    var d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"tc-office\ops");
    Directory.CreateDirectory(d);
    return d;
  }
  static string Hex(string s) {
    using (var sha = System.Security.Cryptography.SHA256.Create()) {
      var sb = new StringBuilder(64);
      foreach (var b in sha.ComputeHash(new UTF8Encoding(false).GetBytes(s))) sb.Append(b.ToString("x2"));
      return sb.ToString();
    }
  }
  static string OpOf(Dictionary<string, object> a) {
    var op = a.ContainsKey("op") ? a["op"] as string : null;
    if (string.IsNullOrEmpty(op) || op.Length > 200) throw new Refusal("refused", "A change needs an operation id.");
    return op;
  }
  static Dictionary<string, object> Record(string file) {
    try { return File.Exists(file) ? new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Deserialize<Dictionary<string, object>>(File.ReadAllText(file)) : null; }
    catch (Exception) { return null; }
  }
  static void Keep(string file, Dictionary<string, object> rec) {
    var temp = file + ".new";
    File.WriteAllText(temp, new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(rec));
    if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
  }
  static void Prune(string dir) {
    if (DateTime.UtcNow - pruned < TimeSpan.FromHours(1)) return;
    pruned = DateTime.UtcNow;
    foreach (var f in Directory.GetFiles(dir, "*.json")) try { if (DateTime.UtcNow - File.GetLastWriteTimeUtc(f) > TimeSpan.FromDays(7)) File.Delete(f); } catch (Exception) { }
  }

  // Runs one change under its operation id, one change at a time. The same id with the same change answers what the
  // first answered (or its refusal) and does nothing; with another change it is refused. A change a stopped helper left
  // unfinished is said so, never run again blind.
  static object Journalled(string verb, Dictionary<string, object> a, Func<object> run) {
    var op = OpOf(a);
    var rest = new Dictionary<string, object>(a);
    rest.Remove("op");
    var digest = Hex(verb + "\n" + new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(rest));
    lock (changing) {
      var dir = OpsDir();
      Prune(dir);
      var file = Path.Combine(dir, Hex(op) + ".json");
      var was = Record(file);
      if (was != null) {
        if (was["digest"] as string != digest) throw new Refusal("refused", "That operation id was used for another change.");
        var state = was["state"] as string;
        if (state == "done") return was["value"];
        if (state == "failed") throw new Refusal(was["code"] as string ?? "failed", was["message"] as string ?? "That change failed.");
        throw new Refusal("failed", "tc-office stopped before this change was known to be done. Look at the folder before trying again.");
      }
      Keep(file, Office.Obj("op", op, "verb", verb, "digest", digest, "state", "running", "at", DateTime.UtcNow.ToString("o")));
      try {
        var value = run();
        Keep(file, Office.Obj("op", op, "verb", verb, "digest", digest, "state", "done", "value", value, "at", DateTime.UtcNow.ToString("o")));
        return value;
      } catch (Exception e) {
        var r = e as Refusal;
        Keep(file, Office.Obj("op", op, "verb", verb, "digest", digest, "state", "failed", "code", r != null ? r.Code : "failed", "message", e.Message, "at", DateTime.UtcNow.ToString("o")));
        throw;
      }
    }
  }

  // What became of an operation id, without doing anything: done (with its answer), failed (with its words), running, or unknown.
  static object Outcome(Dictionary<string, object> a) {
    var op = OpOf(a);
    lock (changing) {
      var was = Record(Path.Combine(OpsDir(), Hex(op) + ".json"));
      if (was == null) return Office.Obj("state", "unknown");
      var state = was["state"] as string;
      if (state == "done") return Office.Obj("state", "done", "verb", was["verb"], "value", was["value"]);
      if (state == "failed") return Office.Obj("state", "failed", "verb", was["verb"], "code", was["code"], "message", was["message"]);
      return Office.Obj("state", "running", "verb", was["verb"]);
    }
  }

  static string OneDriveExe() {
    var local =Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\OneDrive\OneDrive.exe");
    if (File.Exists(local)) return local;
    foreach (var pf in new[] { Environment.GetEnvironmentVariable("ProgramW6432"), Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)") }) {
      if (pf == null) continue;
      var p = Path.Combine(pf, @"Microsoft OneDrive\OneDrive.exe");
      if (File.Exists(p)) return p;
    }
    return null;
  }

  static string Account() {
    using (var accounts = User(@"Software\Microsoft\OneDrive\Accounts")) {
      if (accounts == null) return null;
      foreach (var name in accounts.GetSubKeyNames()) {
        if (!name.StartsWith("Business", StringComparison.OrdinalIgnoreCase)) continue;
        using (var a = accounts.OpenSubKey(name)) {
          var mail = Str(a, "UserEmail");
          var folder = Str(a, "UserFolder");
          if (mail != null && folder != null && Directory.Exists(folder)) return mail;
        }
      }
    }
    return null;
  }

  // Office as installed and signed in here, read from what Office itself keeps: no app is started.
  static object OfficeStatus() {
    var apps = new List<object>();
    foreach (var pair in new[] { new[] { "excel", "Excel.Application" }, new[] { "word", "Word.Application" }, new[] { "powerpoint", "PowerPoint.Application" }, new[] { "outlook", "Outlook.Application" } })
      if (Type.GetTypeFromProgID(pair[1], false) != null) apps.Add(pair[0]);
    string version = null;
    foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 }) {
      try {
        using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
        using (var k = hklm.OpenSubKey(@"SOFTWARE\Microsoft\Office\ClickToRun\Configuration")) { version = version ?? Str(k, "VersionToReport"); }
      } catch (Exception) { }
    }
    const string LICENSING = @"Software\Microsoft\Office\16.0\Common\Licensing\LicensingNext";
    // A signed-in user's licence: his account id (the CID) to the licence's id, written when Office takes one.
    var cids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    using (var map = User(LICENSING + @"\CIDToLicenseIdsMapping")) {
      if (map != null) foreach (var cid in map.GetValueNames()) { cids.Add(cid); var id = Str(map, cid); if (id != null) ids.Add(id); }
    }
    var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    var shared = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
    string account = OfficeAccount(Path.Combine(local, @"Microsoft\OneAuth\accounts"), cids);
    // Builds before OneAuth kept the account here.
    using (var idk = User(@"Software\Microsoft\Office\16.0\Common\Identity\Identities")) {
      if (idk != null) foreach (var id in idk.GetSubKeyNames()) using (var k = idk.OpenSubKey(id)) { account = account ?? Str(k, "EmailAddress") ?? Str(k, "SignInName"); }
    }
    object licensed = null;
    if (apps.Count > 0) {
      // A user's licence that is his (named in the mapping), or a device's, Provisioned and not expired. The grace
      // Office starts with (InstalledGraceKey) and viewer mode hold neither.
      var held = Licensed(Path.Combine(local, @"Microsoft\Office\Licenses"), ids) || Licensed(Path.Combine(shared, @"Microsoft\Office\Licenses"), null);
      using (var old = User(LICENSING + @"\LicenseIdToEmailMapping")) { if (old != null && old.GetValueNames().Length > 0) held = true; }
      licensed = held;
    }
    return Office.Obj("installed", apps.Count > 0, "version", version, "apps", apps, "account", account, "licensed", licensed);
  }

  // The address of the account Office is signed in with, from OneAuth's own record of it (one JSON file per
  // account, no token in it): one associated with Office, the one holding a licence first.
  public static string OfficeAccount(string dir, ICollection<string> licensedCids) {
    string any = null;
    string[] files;
    try { files = Directory.GetFiles(dir); } catch (Exception) { return null; }
    foreach (var file in files) {
      try {
        if (new FileInfo(file).Length > 1 << 20) continue;
        var a = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
        var status = a.ContainsKey("association_status") ? a["association_status"] as string : null;
        var linked = status == null ? null : new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(status);
        if (linked == null || !linked.ContainsKey("com.microsoft.Office") || linked["com.microsoft.Office"] as string != "associated") continue;
        var mail = (a.ContainsKey("email") ? a["email"] as string : null) ?? (a.ContainsKey("login_name") ? a["login_name"] as string : null);
        if (string.IsNullOrEmpty(mail)) continue;
        var id = a.ContainsKey("id") ? a["id"] as string : null;
        if (id != null && licensedCids != null && licensedCids.Contains(id)) return mail;
        any = any ?? mail;
      } catch (Exception) { }
    }
    return any;
  }

  // Whether a folder of Office's licence files (Licenses\5\..., UTF-16 JSON whose License is base64 JSON) holds
  // one in force: Status Provisioned, no ExpiresOn in the past, and its LicenseId among `ids` where those are given.
  public static bool Licensed(string dir, ICollection<string> ids) {
    if (ids != null && ids.Count == 0) return false;
    string[] files;
    try { files = Directory.GetFiles(dir, "*", SearchOption.AllDirectories); } catch (Exception) { return false; }
    foreach (var file in files) {
      try {
        if (new FileInfo(file).Length > 1 << 20) continue;
        var bytes = File.ReadAllBytes(file);
        var text = bytes.Length > 1 && (bytes[1] == 0 || (bytes[0] == 0xFF && bytes[1] == 0xFE)) ? Encoding.Unicode.GetString(bytes) : Encoding.UTF8.GetString(bytes);
        var outer = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text.TrimStart('\uFEFF'));
        var body = outer != null && outer.ContainsKey("License") ? outer["License"] as string : null;
        if (body == null) continue;
        var lic = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Convert.FromBase64String(body)));
        if (InForce(lic, ids, DateTime.UtcNow)) return true;
      } catch (Exception) { }
    }
    return false;
  }

  public static bool InForce(Dictionary<string, object> lic, ICollection<string> ids, DateTime now) {
    if (lic == null || !"Provisioned".Equals(lic.ContainsKey("Status") ? lic["Status"] as string : null, StringComparison.OrdinalIgnoreCase)) return false;
    var id = lic.ContainsKey("LicenseId") ? lic["LicenseId"] as string : null;
    if (ids != null && (id == null || !ids.Contains(id))) return false;
    var ends = lic.ContainsKey("ExpiresOn") ? lic["ExpiresOn"] as string : null;
    DateTime at;
    if (!string.IsNullOrEmpty(ends) && DateTime.TryParse(ends, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out at) && at <= now) return false;
    return true;
  }

  static void Shell(string target) {
    var p = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
    if (p != null) p.Dispose();
  }

  static string Q(Dictionary<string, object> a, string key) { return a.ContainsKey(key) && a[key] != null ? Uri.EscapeDataString(Convert.ToString(a[key])) : ""; }

  public static object Run(string verb, Dictionary<string, object> a) {
    switch (verb) {
      case "guest.status":
        return Office.Obj("onedrive", Office.Obj("installed", OneDriveExe() != null, "running", Process.GetProcessesByName("OneDrive").Length > 0, "account", Account()), "mounts", Mounts(), "office", OfficeStatus(), "verbs", Changes);
      case "files.list": return Dir(Admit(a["dir"]));
      case "files.stat": return Stat(Admit(a["path"]));
      case "files.search": return Search(a);
      case "files.read": {
        var path = Admit(a["path"]);
        // `version`: the file's version as `files.write` checks it, taken before the bytes are read.
        long changed = 0;
        var version = a.ContainsKey("version") && Convert.ToBoolean(a["version"]) ? VersionOf(path, out changed) : null;
        var got = (Dictionary<string, object>)Read(path, a.ContainsKey("offset") ? Convert.ToInt64(a["offset"]) : 0, a.ContainsKey("length") ? Convert.ToInt32(a["length"]) : ReadMax);
        if (version != null) { got["version"] = version; got["changed"] = changed; }
        return got;
      }
      case "files.mkdir": return Journalled(verb, a, () => Mkdir(a));
      case "files.rename": return Journalled(verb, a, () => Rename(a));
      case "files.move": return Journalled(verb, a, () => Move(a));
      case "files.write": return Journalled(verb, a, () => Write(a));
      case "files.recycle": return Journalled(verb, a, () => Recycle(a));
      case "files.restore": return Journalled(verb, a, () => Restore(a));
      case "files.outcome": return Outcome(a);
      case "files.fetch": return Fetch(Admit(a["path"]));
      case "files.free": return Free(Admit(a["path"]));
      case "files.open": Shell(Admit(a["path"])); return null;
      case "onedrive.signin": {
        // OneDrive's own first screen, with his address filled in: he goes on from there.
        var exe = OneDriveExe();
        if (exe == null) throw new Refusal("not-installed", "OneDrive is not installed on this PC.");
        if (Process.GetProcessesByName("OneDrive").Length == 0) { using (Process.Start(new ProcessStartInfo(exe, "/background") { UseShellExecute = true })) { } Thread.Sleep(3000); }
        Shell("odopen://sync?useremail=" + Q(a, "email"));
        return null;
      }
      case "office.start": {
        // Word, started as he would start it: a fresh Office asks for its sign-in there.
        using (var k = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\winword.exe")) {
          var exe = k == null ? null : k.GetValue(null) as string;
          if (exe == null) throw new Refusal("not-installed", "Office is not installed on this PC.");
          if (Process.GetProcessesByName("WINWORD").Length == 0) using (Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true })) { }
        }
        return null;
      }
#if UIA
      case "ui.seen": return Ui.Seen((ArrayList)a["names"], a.ContainsKey("in") ? a["in"] as string : null);
      case "ui.press": return Ui.Press((ArrayList)a["names"], a.ContainsKey("in") ? a["in"] as string : null);
      case "ui.number": return Ui.Number();
#endif
      case "onedrive.sync":
        // The link a library's own Sync button opens, for a library named by its ids.
        Shell("odopen://sync/?siteId=" + Q(a, "siteId") + "&webId=" + Q(a, "webId") + "&listId=" + Q(a, "listId") + "&userEmail=" + Q(a, "email") + "&webUrl=" + Q(a, "webUrl") + "&webTitle=" + Q(a, "webTitle") + "&listTitle=" + Q(a, "listTitle"));
        return null;
    }
    throw new Refusal("failed", "tc-office has no verb " + verb + ".");
  }
}

// ---- The Windows Recycle Bin, through the shell's own file operation (IFileOperation), as Explorer's Delete does it.
// The progress sink sees each delete before it happens: one Windows would do for good (no bin on that drive, the bin
// turned off, a thing too big for it) is cancelled there, so nothing is ever deleted outright. After it, the thing's
// place in the bin is answered.
public static class RecycleBin {
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr pbc, [In] ref Guid bhid, [In] ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attrs);
    void Compare(IShellItem psi, uint hint, out int order);
  }

  [ComImport, Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperationProgressSink {
    [PreserveSig] int StartOperations();
    [PreserveSig] int FinishOperations(int hr);
    [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hr, IShellItem made);
    [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hr, IShellItem made);
    [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hr, IShellItem made);
    [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
    [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int hr, IShellItem made);
    [PreserveSig] int PreNewItem(uint flags, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    [PreserveSig] int PostNewItem(uint flags, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string newName, [MarshalAs(UnmanagedType.LPWStr)] string template, uint attrs, int hr, IShellItem made);
    [PreserveSig] int UpdateProgress(uint total, uint soFar);
    [PreserveSig] int ResetTimer();
    [PreserveSig] int PauseTimer();
    [PreserveSig] int ResumeTimer();
  }

  [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperation {
    uint Advise(IFileOperationProgressSink sink);
    void Unadvise(uint cookie);
    void SetOperationFlags(uint flags);
    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
    void SetProgressDialog(IntPtr dialog);
    void SetProperties(IntPtr props);
    void SetOwnerWindow(IntPtr hwnd);
    void ApplyPropertiesToItem(IShellItem item);
    void ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object items);
    void RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
    void RenameItems([MarshalAs(UnmanagedType.IUnknown)] object items, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    void MoveItem(IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
    void MoveItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem dest);
    void CopyItem(IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
    void CopyItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem dest);
    void DeleteItem(IShellItem item, IFileOperationProgressSink sink);
    void DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object items);
    void NewItem(IShellItem dest, uint attrs, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IFileOperationProgressSink sink);
    void PerformOperations();
    [return: MarshalAs(UnmanagedType.Bool)] bool GetAnyOperationsAborted();
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [In] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

  const uint FOF_SILENT = 0x4, FOF_NOCONFIRMATION = 0x10, FOF_ALLOWUNDO = 0x40, FOF_NOCONFIRMMKDIR = 0x200, FOF_NOERRORUI = 0x400, FOFX_RECYCLEONDELETE = 0x80000;
  const uint TSF_DELETE_RECYCLE_IF_POSSIBLE = 0x80, SIGDN_FILESYSPATH = 0x80058000;
  const int E_ABORT = unchecked((int)0x80004004);

  [ComVisible(true)]
  public sealed class Sink : IFileOperationProgressSink {
    public bool WouldNuke;
    public int Hr;
    public string Bin;
    public int PreDeleteItem(uint flags, IShellItem item) {
      if ((flags & TSF_DELETE_RECYCLE_IF_POSSIBLE) != 0) return 0;
      WouldNuke = true;
      return E_ABORT;
    }
    public int PostDeleteItem(uint flags, IShellItem item, int hr, IShellItem made) {
      Hr = hr;
      if (made != null) { try { string p; made.GetDisplayName(SIGDN_FILESYSPATH, out p); Bin = p; } catch (Exception) { Bin = ""; } }
      return 0;
    }
    public int StartOperations() { return 0; }
    public int FinishOperations(int hr) { return 0; }
    public int PreRenameItem(uint flags, IShellItem item, string newName) { return 0; }
    public int PostRenameItem(uint flags, IShellItem item, string newName, int hr, IShellItem made) { return 0; }
    public int PreMoveItem(uint flags, IShellItem item, IShellItem dest, string newName) { return 0; }
    public int PostMoveItem(uint flags, IShellItem item, IShellItem dest, string newName, int hr, IShellItem made) { return 0; }
    public int PreCopyItem(uint flags, IShellItem item, IShellItem dest, string newName) { return 0; }
    public int PostCopyItem(uint flags, IShellItem item, IShellItem dest, string newName, int hr, IShellItem made) { return 0; }
    public int PreNewItem(uint flags, IShellItem dest, string newName) { return 0; }
    public int PostNewItem(uint flags, IShellItem dest, string newName, string template, uint attrs, int hr, IShellItem made) { return 0; }
    public int UpdateProgress(uint total, uint soFar) { return 0; }
    public int ResetTimer() { return 0; }
    public int PauseTimer() { return 0; }
    public int ResumeTimer() { return 0; }
  }

  // Sends one file or folder to the bin on a thread of its own (the shell wants a single-threaded apartment). Answers
  // where it lies in the bin.
  public static string Send(string path) {
    var sink = new Sink();
    Exception failed = null;
    var t = new Thread(() => {
      try {
        var iid = typeof(IShellItem).GUID;
        IShellItem item;
        SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
        var op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
        try {
          op.SetOperationFlags(FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR | FOF_NOERRORUI);
          op.DeleteItem(item, sink);
          op.PerformOperations();
          if (op.GetAnyOperationsAborted() && !sink.WouldNuke) failed = new Refusal("failed", "Windows stopped before " + Path.GetFileName(path) + " reached the Recycle Bin.");
        } finally { Marshal.ReleaseComObject(op); Marshal.ReleaseComObject(item); }
      } catch (Exception e) { failed = e; }
    });
    t.SetApartmentState(ApartmentState.STA);
    t.IsBackground = true;
    t.Start();
    t.Join();
    if (sink.WouldNuke) throw new Refusal("refused", "Windows would delete " + Path.GetFileName(path) + " for good rather than keep it in the Recycle Bin, so it was left where it is.");
    if (failed != null) throw failed as Refusal ?? new Refusal("failed", "Windows could not move " + Path.GetFileName(path) + " to the Recycle Bin: " + failed.Message);
    if (sink.Hr < 0) throw new Refusal("failed", "Windows could not move " + Path.GetFileName(path) + " to the Recycle Bin (0x" + sink.Hr.ToString("X8") + ").");
    if (sink.Bin == null) throw new Refusal("failed", "Windows did not say that " + Path.GetFileName(path) + " reached the Recycle Bin. Look in the Recycle Bin before trying again.");
    return sink.Bin;
  }
}

#if UIA
// ---- OneDrive's and Office's own sign-in windows, walked by name (docs/agents/work-winvm.md "Signing in").
// Compiled only for the box's Windows VM (/define:UIA): it presses a button or a link of the sign-in the
// owner asked for, by the words on it, and never types anything.
public static class Ui {
  static readonly string[] PROCESSES = { "OneDrive", "Microsoft.AAD.BrokerPlugin", "WINWORD", "EXCEL", "POWERPNT", "OfficeC2RClient", "msedgewebview2" };

  // An element of that name that belongs to a sign-in's own process, wherever its frame sits (the
  // account broker's page is drawn inside a frame window of the shell's).
  // `only`: one of those processes by name, when the caller means that app's own window alone.
  static System.Windows.Automation.AutomationElement Find(string name, string only) {
    var pids = new HashSet<int>();
    foreach (var n in PROCESSES) {
      if (only != null && !n.Equals(only, StringComparison.OrdinalIgnoreCase)) continue;
      foreach (var p in Process.GetProcessesByName(n)) { pids.Add(p.Id); p.Dispose(); }
    }
    var cond = new System.Windows.Automation.PropertyCondition(System.Windows.Automation.AutomationElement.NameProperty, name, System.Windows.Automation.PropertyConditionFlags.IgnoreCase);
    var root = System.Windows.Automation.AutomationElement.RootElement;
    System.Windows.Automation.AutomationElement said = null;
    foreach (System.Windows.Automation.AutomationElement w in root.FindAll(System.Windows.Automation.TreeScope.Children, System.Windows.Automation.Condition.TrueCondition)) {
      try {
        var cls = w.Current.ClassName;
        if (cls == "Shell_TrayWnd" || cls == "Progman") continue;
        foreach (System.Windows.Automation.AutomationElement hit in w.FindAll(System.Windows.Automation.TreeScope.Descendants, cond)) {
          if (!pids.Contains(hit.Current.ProcessId)) continue;
          // A page may say a button's words in its text too ("Consider choosing No, this app only"): the control wins.
          var type = hit.Current.ControlType;
          if (type == System.Windows.Automation.ControlType.Button || type == System.Windows.Automation.ControlType.Hyperlink || type == System.Windows.Automation.ControlType.ListItem) return hit;
          if (said == null) said = hit;
        }
      } catch (Exception) { }
    }
    return said;
  }

  // Whether any of the names is on a sign-in window now, and which.
  public static object Seen(ArrayList names, string only) {
    foreach (var n in names) if (Find((string)n, only) != null) return (string)n;
    return null;
  }

  // Presses the first of the names found: its own Invoke, else a click at its middle.
  public static object Press(ArrayList names, string only) {
    foreach (var n in names) {
      var e = Find((string)n, only);
      if (e == null) continue;
      object pattern;
      if (e.TryGetCurrentPattern(System.Windows.Automation.InvokePattern.Pattern, out pattern)) { ((System.Windows.Automation.InvokePattern)pattern).Invoke(); return (string)n; }
      if (e.TryGetCurrentPattern(System.Windows.Automation.SelectionItemPattern.Pattern, out pattern)) { ((System.Windows.Automation.SelectionItemPattern)pattern).Select(); return (string)n; }
      var r = e.Current.BoundingRectangle;
      if (r.IsEmpty) continue;
      SetCursorPos((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2));
      mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
      return (string)n;
    }
    return null;
  }
  // The number on Microsoft's "Approve sign in" page: an element of the account broker's (or its web view's) whose
  // name is two or three digits alone. Only the broker's windows and the shell frames it draws in are walked.
  public static object Number() {
    var pids = new HashSet<int>();
    foreach (var n in new[] { "Microsoft.AAD.BrokerPlugin", "msedgewebview2", "OneDrive" })
      foreach (var p in Process.GetProcessesByName(n)) { pids.Add(p.Id); p.Dispose(); }
    var root = System.Windows.Automation.AutomationElement.RootElement;
    foreach (System.Windows.Automation.AutomationElement w in root.FindAll(System.Windows.Automation.TreeScope.Children, System.Windows.Automation.Condition.TrueCondition)) {
      try {
        if (!pids.Contains(w.Current.ProcessId) && w.Current.ClassName != "ApplicationFrameWindow") continue;
        foreach (System.Windows.Automation.AutomationElement e in w.FindAll(System.Windows.Automation.TreeScope.Descendants, System.Windows.Automation.Condition.TrueCondition)) {
          if (!pids.Contains(e.Current.ProcessId)) continue;
          var name = (e.Current.Name ?? "").Trim();
          if (name.Length >= 2 && name.Length <= 3 && Digits(name)) return name;
        }
      } catch (Exception) { }
    }
    return null;
  }

  static bool Digits(string s) { foreach (var c in s) if (c < '0' || c > '9') return false; return true; }

  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
#endif

public static class Program {
  static readonly object outLock = new object();
  static StreamWriter stdout;
  static JavaScriptSerializer json;

  static JavaScriptSerializer NewJson() {
    var j = new JavaScriptSerializer();
    j.MaxJsonLength = int.MaxValue;
    j.RecursionLimit = 64;
    return j;
  }

  // Standard output, or in `serve` every connection: where an event of Excel's goes.
  static Action<string> everyone;

  static void Emit(Dictionary<string, object> o) { everyone(json.Serialize(o)); }

  [STAThread]
  public static int Main(string[] argv) {
    json = NewJson();
    string listen = null, tokenFile = null;
    for (var i = 0; i < argv.Length; i++) {
      if (argv[i] == "--listen" && i + 1 < argv.Length) listen = argv[++i];
      else if (argv[i] == "--token-file" && i + 1 < argv.Length) tokenFile = argv[++i];
    }
    var serve = argv.Length > 0 && argv[0] == "serve";
    if (serve && (listen == null || tokenFile == null)) return 64;
#if RECORDED
    var com = new RecordedCom();
#else
    ICom com = new RealCom();
#endif
    var office = new Office(com, Emit);
    MessageFilter.Register();
    // Calls and Excel's events run on this one STA thread, pumped by the message loop; requests are read beside it.
    // An exception that escapes a request ends the helper (TempCode starts another) rather than showing a dialog on his desktop.
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
    var pump = new Control();
    pump.CreateControl();
    if (pump.Handle == IntPtr.Zero) return 1;
    if (serve) {
      var code = Door.Start(office, com, pump, listen, tokenFile);
      if (code != 0) return code;
      everyone = Door.Broadcast;
      Application.Run();
      return 0;
    }
    stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    stdout.AutoFlush = true;
    everyone = line => { lock (outLock) { stdout.WriteLine(line); } };
    var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var reader = new Thread(() => {
      string line;
      while ((line = stdin.ReadLine()) != null) {
        var l = line;
        if (l.Trim().Length > 0) pump.BeginInvoke(new Action(() => Handle(office, com, l, everyone)));
      }
      pump.BeginInvoke(new Action(Application.ExitThread));
    });
    reader.IsBackground = true;
    reader.Start();
    Emit(Office.Obj("event", "ready", "version", Office.Version, "pid", Process.GetCurrentProcess().Id));
    Application.Run();
    return 0;
  }

  // One request, on the STA thread; its answer goes to `send`, the connection that asked.
  public static void Handle(Office office, object com, string line, Action<string> send) {
    object id = null;
    string verb = "";
    try {
      var req = json.Deserialize<Dictionary<string, object>>(line);
      id = req.ContainsKey("id") ? req["id"] : null;
      verb = req.ContainsKey("verb") ? (string)req["verb"] : "";
      var args = req.ContainsKey("args") && req["args"] != null ? (Dictionary<string, object>)req["args"] : new Dictionary<string, object>();
      object value;
#if RECORDED
      if (verb.StartsWith("_")) value = ((RecordedCom)com).Test(verb, args, office);
      else
#endif
      value = Guest.Has(verb) ? Guest.Run(verb, args) : office.Run(verb, args);
      send(json.Serialize(Office.Obj("id", id, "ok", true, "value", value)));
    } catch (Exception e) {
      try { send(json.Serialize(Office.Obj("id", id, "ok", false, "error", Office.Failure(verb, e)))); }
      catch (Exception) { Environment.Exit(2); }
    } finally {
      try { office.AfterRequest(); } catch (Exception x) { Console.Error.WriteLine("tc-office: letting go: " + x.Message); }
    }
  }
}

// `serve --listen 127.0.0.1:PORT --token-file FILE`: the helper as a door on this PC's loopback, for a
// host that reaches it through a tunnel (the box and its Windows VM). A connection's first line is the
// token; then the same frames as over stdin and stdout. Several connections at once: Office's verbs
// still run one at a time on the STA thread, the folder verbs on their connection's own thread.
static class Door {
  static readonly List<Action<string>> clients = new List<Action<string>>();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  // .NET Framework makes sockets inheritable: a program the helper starts (OneDrive, Word, a file's app) kept the
  // listening socket, so a helper put in its place could not listen until those closed (2026-11-23).
  static void NoInherit(System.Net.Sockets.Socket s) { SetHandleInformation(s.Handle, 1, 0); }
  static Office office;
  static object com;
  static Control pump;
  static string token;

  public static int Start(Office o, object c, Control p, string listen, string tokenFile) {
    office = o; com = c; pump = p;
    try { token = File.ReadAllText(tokenFile).Trim(); } catch (Exception) { return 66; }
    if (token.Length < 32) return 66;
    var at = listen.LastIndexOf(':');
    System.Net.IPAddress ip;
    int port;
    if (at <= 0 || !System.Net.IPAddress.TryParse(listen.Substring(0, at), out ip) || !int.TryParse(listen.Substring(at + 1), out port) || !System.Net.IPAddress.IsLoopback(ip)) return 64;
    var listener = new System.Net.Sockets.TcpListener(ip, port);
    // Another helper already holds the port: that one serves.
    try { listener.Start(); } catch (System.Net.Sockets.SocketException) { return 3; }
    NoInherit(listener.Server);
    var accept = new Thread(() => {
      for (;;) {
        System.Net.Sockets.TcpClient client;
        try { client = listener.AcceptTcpClient(); } catch (Exception) { break; }
        NoInherit(client.Client);
        var t = new Thread(() => { try { Serve(client); } catch (Exception) { } finally { try { client.Close(); } catch (Exception) { } } });
        t.IsBackground = true;
        t.Start();
      }
    });
    accept.IsBackground = true;
    accept.Start();
    return 0;
  }

  public static void Broadcast(string line) {
    Action<string>[] all;
    lock (clients) all = clients.ToArray();
    foreach (var send in all) send(line);
  }

  static bool Same(string a, string b) {
    if (a == null || a.Length != b.Length) return false;
    var diff = 0;
    for (var i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
    return diff == 0;
  }

  static void Serve(System.Net.Sockets.TcpClient client) {
    client.NoDelay = true;
    var stream = client.GetStream();
    var reader = new StreamReader(stream, new UTF8Encoding(false));
    var writer = new StreamWriter(stream, new UTF8Encoding(false));
    var mine = new JavaScriptSerializer();
    mine.MaxJsonLength = int.MaxValue;
    mine.RecursionLimit = 64;
    stream.ReadTimeout = 10000;
    if (!Same(reader.ReadLine(), token)) return;
    stream.ReadTimeout = System.Threading.Timeout.Infinite;
    Action<string> send = line => { try { lock (writer) { writer.WriteLine(line); writer.Flush(); } } catch (Exception) { } };
    lock (clients) clients.Add(send);
    try {
      send(mine.Serialize(Office.Obj("event", "ready", "version", Office.Version, "pid", Process.GetCurrentProcess().Id)));
      string line;
      while ((line = reader.ReadLine()) != null) {
        if (line.Trim().Length == 0) continue;
        var l = line;
        string verb = "";
        object id = null;
        Dictionary<string, object> args = null;
        try {
          var req = mine.Deserialize<Dictionary<string, object>>(l);
          id = req.ContainsKey("id") ? req["id"] : null;
          verb = req.ContainsKey("verb") ? req["verb"] as string ?? "" : "";
          args = req.ContainsKey("args") && req["args"] != null ? (Dictionary<string, object>)req["args"] : new Dictionary<string, object>();
        } catch (Exception) { }
        if (args == null || !Guest.Has(verb)) { pump.BeginInvoke(new Action(() => Program.Handle(office, com, l, send))); continue; }
        try { send(mine.Serialize(Office.Obj("id", id, "ok", true, "value", Guest.Run(verb, args)))); }
        catch (Exception e) { send(mine.Serialize(Office.Obj("id", id, "ok", false, "error", Office.Failure(verb, e)))); }
      }
    } finally {
      bool none;
      lock (clients) { clients.Remove(send); none = clients.Count == 0; }
      // Nobody listens for Excel's changes any more: let go of the Excel held for them.
      if (none) pump.BeginInvoke(new Action(() => { try { office.Watch(false); office.AfterRequest(); } catch (Exception) { } }));
    }
  }
}
}
