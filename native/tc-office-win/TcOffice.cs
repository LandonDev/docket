// tc-office: TempCode's Office helper on Windows (docs/agents/work-office.md "Windows").
//
// Drives the Excel, Word, PowerPoint and classic Outlook the owner has open, by COM, in his own
// session. Spoken to by TempCode over stdin and stdout, one JSON object per line:
//   in:  {"id":1,"verb":"readRange","args":{...}}
//   out: {"id":1,"ok":true,"value":...}  or  {"id":1,"ok":false,"error":{"code":"busy","message":"...","hresult":"0x80010001"}}
//   out: {"event":"ready","version":1}  once, and {"event":"changed","book":...,"sheet":...,"address":"B2:C3"} from Excel
// It never starts an app unseen (save `open`, the switch), never sends on its own, and exits when
// its stdin closes. Every COM call goes through ICom, so the tests run it against a recorded
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
  void Advise(object source, Guid iid, int dispid, Delegate handler);
  // Starts a program, or opens a document or URI with its handler (the switch).
  void Start(string file, string args);
  // The app's exe from App Paths, or null.
  string AppPath(string exe);
  void Foreground(int hwnd);
}

public class RealCom : ICom {
  public bool Registered(string progId) { return Type.GetTypeFromProgID(progId, false) != null; }
  public bool Running(string processName) { return Process.GetProcessesByName(processName).Length > 0; }
  public object Active(string progId) { return Marshal.GetActiveObject(progId); }
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
  public void Advise(object source, Guid iid, int dispid, Delegate handler) { ComEventsHelper.Combine(source, iid, dispid, handler); }
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
  public void Foreground(int hwnd) {
    var h = new IntPtr(hwnd);
    if (IsIconic(h)) ShowWindow(h, 9);
    SetForegroundWindow(h);
  }
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

public class Office {
  public const int Version = 1;
  readonly ICom com;
  readonly Action<Dictionary<string, object>> emit;
  public Office(ICom com, Action<Dictionary<string, object>> emit) { this.com = com; this.emit = emit; }

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
    object a;
    if (attached.TryGetValue(app, out a)) {
      try { com.Get(a, "Version"); return a; } catch (Exception) { attached.Remove(app); if (advised == a) advised = null; }
    }
    if (!com.Registered(ProgId(app))) throw new Refusal("not-installed", Named(app) + " is not installed on this PC.");
    if (!com.Running(Proc(app))) throw new Refusal("not-running", Named(app) + " is not open.");
    try { a = com.Active(ProgId(app)); }
    catch (COMException e) {
      if ((uint)e.ErrorCode == 0x800401E3) throw new Refusal("not-running", Named(app) + " is open but not reachable: it may be starting, or running as administrator while TempCode is not.");
      throw;
    }
    attached[app] = a;
    if (app == "excel" && watching) Advise(a);
    return a;
  }

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
  static readonly Guid AppEvents = new Guid("00024413-0000-0000-C000-000000000046");
  const int DispSheetChange = 0x61c;

  public object Watch(bool on) {
    watching = on;
    if (on && attached.ContainsKey("excel")) Advise(attached["excel"]);
    return null;
  }

  void Advise(object xl) {
    if (advised == xl) return;
    try { com.Advise(xl, AppEvents, DispSheetChange, new SheetChangeHandler(SheetChanged)); advised = xl; }
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
    object ws;
    try { ws = com.Call(com.Get(b, "Worksheets"), "Item", sheet); }
    catch (COMException) { throw new Refusal("not-found", book + " has no sheet " + sheet + "."); }
    return com.Get(ws, "Range", address);
  }

  public object ReadRange(string book, string sheet, string address) {
    var r = Range(book, sheet, address);
    var values = Grid(com.Get(r, "Value"));
    object f;
    try { f = com.Get(r, "Formula2"); }
    catch (COMException e) { if ((uint)e.ErrorCode != 0x80020006) throw; f = com.Get(r, "Formula"); }
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
        catch (COMException e) { if ((uint)e.ErrorCode != 0x80020006) throw; com.Set(r, "Formula", v); }
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
    if (v is string) return (string)v;
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
      // Find, set the found range's text, go on after it: Word's own replace takes at most 255 characters.
      var r = com.Get(d, "Content");
      var f = com.Get(r, "Find");
      com.Set(f, "Text", find);
      com.Set(f, "MatchCase", true);
      com.Set(f, "MatchWildcards", false);
      com.Set(f, "Forward", true);
      com.Set(f, "Wrap", 0);
      var n = 0;
      while (Convert.ToBoolean(com.Call(f, "Execute")) && n < 10000) {
        com.Set(r, "Text", replace);
        com.Call(r, "Collapse", 0);
        n++;
      }
      return n;
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
    catch (COMException e) { if ((uint)e.ErrorCode == 0x80004004) throw; return null; }
  }

  string SmtpOf(object recipient) {
    var smtp = Lower(Prop(recipient, PR_SMTP));
    if (smtp != "") return smtp;
    try {
      var entry = com.Get(recipient, "AddressEntry");
      try { var u = com.Call(entry, "GetExchangeUser"); if (u != null) { var p = Lower(com.Get(u, "PrimarySmtpAddress")); if (p != "") return p; } } catch (COMException e) { if ((uint)e.ErrorCode == 0x80004004) throw; }
      var a = Lower(com.Get(entry, "Address"));
      if (a.Contains("@")) return a;
    } catch (COMException e) { if ((uint)e.ErrorCode == 0x80004004) throw; }
    return "";
  }

  string SenderOf(object item) {
    var smtp = Lower(Prop(item, PR_SENDER_SMTP));
    if (smtp != "") return smtp;
    if (Lower(com.Get(item, "SenderEmailType")) == "smtp") return Lower(com.Get(item, "SenderEmailAddress"));
    try { var u = com.Call(com.Get(item, "Sender"), "GetExchangeUser"); if (u != null) return Lower(com.Get(u, "PrimarySmtpAddress")); } catch (COMException e) { if ((uint)e.ErrorCode == 0x80004004) throw; }
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
    catch (COMException e) { if ((uint)e.ErrorCode == 0x80004004) throw; throw new Refusal("not-found", "Outlook has no item " + id + "."); }
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

  // A draft left in Drafts (answers its id), or a mail sent: only ever from a held act's execute, after his press.
  public object Mail(Dictionary<string, object> m, bool send) {
    var ns = Ns();
    var app = App("outlook");
    object mail;
    var html = (string)m["html"] ?? "";
    if (m.ContainsKey("replyTo") && m["replyTo"] != null) {
      // A reply goes to the sender Outlook has for the original, as the held card said.
      mail = com.Call(ItemById(ns, (string)m["replyTo"]), "Reply");
      InsertHtml(mail, html);
    } else if (m.ContainsKey("forward") && m["forward"] != null) {
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
    com.Call(com.Get(mail, "Recipients"), "ResolveAll");
    if (!send) { com.Call(mail, "Save"); return com.Get(mail, "EntryID"); }
    com.Call(mail, "Send");
    return null;
  }

  object Calendar(object ns, string account) {
    if (string.IsNullOrEmpty(account)) return com.Call(ns, "GetDefaultFolder", 9);
    return com.Call(com.Get(Account(ns, account), "DeliveryStore"), "GetDefaultFolder", 9);
  }

  // Events starting in [from, to): sorted, recurrences expanded, then restricted, in that order.
  IEnumerable<object> Between(object folder, DateTime from, DateTime to) {
    var items = com.Get(folder, "Items");
    com.Call(items, "Sort", "[Start]");
    com.Set(items, "IncludeRecurrences", true);
    var f = "[Start] >= '" + from.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) + "' AND [Start] < '" + to.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) + "'";
    var hits = com.Call(items, "Restrict", f);
    var item = com.Call(hits, "GetFirst");
    for (var n = 0; item != null && n < 500; n++) {
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
    var ns = Ns();
    var items = com.Get(Calendar(ns, e.ContainsKey("account") ? e["account"] as string : null), "Items");
    var a = com.Call(items, "Add", 1);
    com.Set(a, "Subject", (string)e["subject"] ?? "");
    com.Set(a, "Start", Parse(e["start"]).ToLocalTime());
    com.Set(a, "End", Parse(e["end"]).ToLocalTime());
    if (e.ContainsKey("location") && e["location"] != null) com.Set(a, "Location", (string)e["location"]);
    if (e.ContainsKey("body") && e["body"] != null) com.Set(a, "Body", (string)e["body"]);
    var attendees = e["attendees"] as ArrayList;
    var invites = attendees != null && attendees.Count > 0;
    if (invites) {
      com.Set(a, "MeetingStatus", 1);
      AddRecipients(a, attendees, 1);
      com.Call(com.Get(a, "Recipients"), "ResolveAll");
    }
    com.Call(a, "Save");
    var id = com.Get(a, "EntryID");
    if (invites) com.Call(a, "Send");
    return id;
  }

  // The event whose iCalendar UID is `uid`: Outlook's own GlobalAppointmentID in hex, or one carrying a vCal-Uid.
  public object EventByUid(string uid) {
    var ns = Ns();
    var now = DateTime.UtcNow;
    foreach (var e in Between(com.Call(ns, "GetDefaultFolder", 9), now.AddDays(-7), now.AddDays(183))) {
      var g = (string)com.Get(e, "GlobalAppointmentID") ?? "";
      if (string.Equals(g, uid, StringComparison.OrdinalIgnoreCase) || VCalUid(g) == uid) return com.Get(e, "EntryID");
    }
    return null;
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
    var ns = Ns();
    var e = ItemById(ns, id);
    var r = com.Call(e, "Respond", answer == "accept" ? 3 : answer == "decline" ? 4 : 2, true);
    if (r != null) {
      if (!string.IsNullOrEmpty(comment)) com.Set(r, "Body", comment);
      com.Call(r, "Send");
    }
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
    { "presentations", "powerpoint" }, { "readSlides", "powerpoint" }, { "replaceSlideText", "powerpoint" }
  };

  // Any failure as {code, message, hresult}: COM's own codes in words.
  public static Dictionary<string, object> Failure(string verb, Exception e) {
    var r = e as Refusal;
    if (r != null) return Obj("code", r.Code, "message", r.Message);
    string app;
    var name = Named(APP_OF_VERB.TryGetValue(verb, out app) ? app : "outlook");
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

public static class Program {
  static readonly object outLock = new object();
  static StreamWriter stdout;
  static JavaScriptSerializer json;

  static void Emit(Dictionary<string, object> o) {
    var line = json.Serialize(o);
    lock (outLock) { stdout.WriteLine(line); }
  }

  [STAThread]
  public static int Main(string[] argv) {
    json = new JavaScriptSerializer();
    json.MaxJsonLength = int.MaxValue;
    json.RecursionLimit = 64;
    stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    stdout.AutoFlush = true;
    var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
#if RECORDED
    var com = new RecordedCom();
#else
    ICom com = new RealCom();
#endif
    var office = new Office(com, Emit);
    MessageFilter.Register();
    // Calls and Excel's events run on this one STA thread, pumped by the message loop; stdin is read beside it.
    var pump = new Control();
    pump.CreateControl();
    if (pump.Handle == IntPtr.Zero) return 1;
    var reader = new Thread(() => {
      string line;
      while ((line = stdin.ReadLine()) != null) {
        var l = line;
        if (l.Trim().Length > 0) pump.BeginInvoke(new Action(() => Handle(office, com, l)));
      }
      pump.BeginInvoke(new Action(Application.ExitThread));
    });
    reader.IsBackground = true;
    reader.Start();
    Emit(Office.Obj("event", "ready", "version", Office.Version, "pid", Process.GetCurrentProcess().Id));
    Application.Run();
    return 0;
  }

  static void Handle(Office office, object com, string line) {
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
      value = office.Run(verb, args);
      Emit(Office.Obj("id", id, "ok", true, "value", value));
    } catch (Exception e) {
      Emit(Office.Obj("id", id, "ok", false, "error", Office.Failure(verb, e)));
    }
  }
}
}
