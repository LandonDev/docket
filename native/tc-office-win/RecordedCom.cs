// The recorded COM surface: Excel, Word, PowerPoint and classic Outlook as objects in memory, for
// tc-office's tests where no Office is installed (the rig). Compiled in only with /define:RECORDED;
// the shipped helper never carries it.
//
// It answers in the shapes Office's own IDispatch answers, as Microsoft documents them, and keeps
// the quirks the helper must survive: a block's Value as a 1-based object[,] and a single cell's as a
// scalar; NumberFormat null over cells that differ; a cell's error as an Int32 (VT_ERROR); dates as
// DateTime in local time; an unknown member as DISP_E_UNKNOWNNAME; a missing sheet as DISP_E_BADINDEX;
// a closed app as MK_E_UNAVAILABLE; a busy app as RPC_E_CALL_REJECTED; Outlook's object model guard as
// E_ABORT; Excel's SheetChange event, raised for writes made through it as well as for typing.
// Test verbs (`_seed`, `_type`, `_busy`, `_state`) set it up and read what reached it.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace TcOffice {

public class Obj {
  public readonly string Kind;
  public readonly Dictionary<string, Func<object[], object>> G = new Dictionary<string, Func<object[], object>>();
  public readonly Dictionary<string, Action<object>> S = new Dictionary<string, Action<object>>();
  public Obj(string kind) { Kind = kind; }
  public Obj Prop(string name, Func<object> get) { G[name] = a => get(); return this; }
  public Obj Fn(string name, Func<object[], object> fn) { G[name] = fn; return this; }
  public Obj Put(string name, Action<object> set) { S[name] = set; return this; }
}

class XCell { public object V; public string F = ""; public string Z = "General"; }
class XSheet { public string Name; public Dictionary<long, XCell> Cells = new Dictionary<long, XCell>(); public XBook Book; }
class XBook { public string Key, Name; public List<XSheet> Sheets = new List<XSheet>(); }
class WDoc { public string Key, Name, Text; public bool Track; public List<string> Tracked = new List<string>(); }
class PDeck { public string Key, Name; public List<List<string>> Slides = new List<List<string>>(); }
class OMail {
  public string Id, Account, From = "", ReplyTo, Subject = "", Html = "", Text = "", Folder = "inbox"; public DateTime At; public bool Read = true; public int Class = 43;
  public List<object[]> Recipients = new List<object[]>(); public object SendUsing;
}
class OEvent { public string Id, Subject = "", Location = "", Organizer = "", Global = "", Body = ""; public DateTime Start, End; public int Response, Meeting; public List<object[]> Recipients = new List<object[]>(); }

public class RecordedCom : ICom {
  public static readonly int E_UNKNOWN = unchecked((int)0x80020006), E_BADINDEX = unchecked((int)0x8002000B), E_UNAVAILABLE = unchecked((int)0x800401E3), E_REJECTED = unchecked((int)0x80010001), E_ABORT = unchecked((int)0x80004004);

  readonly Dictionary<string, bool> installed = new Dictionary<string, bool>(), running = new Dictionary<string, bool>(), visible = new Dictionary<string, bool>();
  // The next call to this member fails with this HRESULT, once.
  string failMember; int failCode;
  bool oldExcel, guard;
  int busy;
  readonly List<XBook> books = new List<XBook>();
  readonly List<WDoc> docs = new List<WDoc>();
  readonly List<PDeck> decks = new List<PDeck>();
  readonly List<string> accounts = new List<string>();
  readonly List<OMail> mail = new List<OMail>();
  readonly List<OEvent> events = new List<OEvent>();
  readonly List<object> thrownAway = new List<object>();
  readonly List<object> sent = new List<object>(), answers = new List<object>(), started = new List<object>(), calls = new List<object>();
  int nextId = 1000;
  Delegate sheetChange;
  Obj excel, word, powerpoint, outlook;

  public RecordedCom() { Seed(new Dictionary<string, object>()); }

  static COMException Err(int hr, string message) { return new COMException(message, hr); }

  // ---- ICom
  static string AppOfProgId(string p) { return p.Split('.')[0].ToLowerInvariant(); }
  static string AppOfProc(string p) { return p == "EXCEL" ? "excel" : p == "WINWORD" ? "word" : p == "POWERPNT" ? "powerpoint" : "outlook"; }
  public bool Registered(string progId) { return installed[AppOfProgId(progId)]; }
  public bool Running(string proc) { return installed[AppOfProc(proc)] && running[AppOfProc(proc)]; }
  public object Active(string progId) {
    var app = AppOfProgId(progId);
    if (!installed[app] || !running[app]) throw Err(E_UNAVAILABLE, "Operation unavailable (Exception from HRESULT: 0x800401E3 (MK_E_UNAVAILABLE))");
    return app == "excel" ? excel : app == "word" ? word : app == "powerpoint" ? powerpoint : outlook;
  }
  object Active2(string app) { return app == "excel" ? excel : app == "word" ? word : app == "powerpoint" ? powerpoint : outlook; }
  void Busy(string what) {
    calls.Add(what);
    if (busy > 0) { busy--; throw Err(E_REJECTED, "Call was rejected by callee. (Exception from HRESULT: 0x80010001 (RPC_E_CALL_REJECTED))"); }
    if (failMember != null && what.EndsWith("." + failMember)) { failMember = null; throw Err(failCode, "Failed (Exception from HRESULT: 0x" + failCode.ToString("X8") + ")"); }
  }
  public object Get(object o, string name, params object[] args) {
    var x = (Obj)o;
    Busy(x.Kind + "." + name);
    // An app that quit leaves its proxy answering RPC_S_SERVER_UNAVAILABLE.
    foreach (var app in new[] { "excel", "word", "powerpoint", "outlook" })
      if (o == Active2(app) && !(installed[app] && running[app])) throw Err(unchecked((int)0x800706BA), "The RPC server is unavailable. (Exception from HRESULT: 0x800706BA)");
    Func<object[], object> f;
    if (!x.G.TryGetValue(name, out f)) throw Err(E_UNKNOWN, "Unknown name. (Exception from HRESULT: 0x80020006 (DISP_E_UNKNOWNNAME))");
    return f(args);
  }
  public void Set(object o, string name, object value) {
    var x = (Obj)o;
    Busy(x.Kind + "." + name + "=");
    Action<object> f;
    if (!x.S.TryGetValue(name, out f)) throw Err(E_UNKNOWN, "Unknown name. (Exception from HRESULT: 0x80020006 (DISP_E_UNKNOWNNAME))");
    f(value);
  }
  public object Call(object o, string name, params object[] args) { return Get(o, name, args); }
  // The surface reading itself: not a call the helper made.
  static object Raw(object o, string name) { return ((Obj)o).G[name](new object[0]); }
  public void Advise(object source, string name, Delegate handler) {
    var o = (Obj)source;
    if (o == excel && name == "SheetChange") { sheetChange = handler; return; }
    if (o.Kind == "Workbook" && name == "AfterRemoteChange") { var key = (string)Raw(o, "FullName"); remote[key] = remote.ContainsKey(key) ? Delegate.Combine(remote[key], handler) : handler; return; }
    throw Err(E_UNKNOWN, "no event " + name);
  }
  readonly Dictionary<string, Delegate> remote = new Dictionary<string, Delegate>();
  public void Start(string file, string args) { started.Add(Office.Obj("file", file, "args", args)); }
  public string AppPath(string exe) { return @"C:\Program Files\Microsoft Office\root\Office16\" + exe.ToUpperInvariant(); }
  public void Foreground(int hwnd) { started.Add(Office.Obj("foreground", hwnd)); }
  public void Release(object o) { }

  // ---- A1
  static readonly Regex A1 = new Regex(@"^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$");
  static int Col(string s) { var n = 0; foreach (var ch in s) n = n * 26 + (ch - 'A' + 1); return n; }
  static string ColName(int c) { var s = ""; while (c > 0) { var m = (c - 1) % 26; s = (char)('A' + m) + s; c = (c - 1) / 26; } return s; }
  static int[] Parse(string a) {
    var m = A1.Match(a.ToUpperInvariant());
    if (!m.Success) throw Err(unchecked((int)0x800A03EC), "Exception from HRESULT: 0x800A03EC");
    int r1 = int.Parse(m.Groups[2].Value), c1 = Col(m.Groups[1].Value);
    return m.Groups[3].Success ? new[] { r1, c1, int.Parse(m.Groups[4].Value), Col(m.Groups[3].Value) } : new[] { r1, c1, r1, c1 };
  }
  static long K(int r, int c) { return (long)r * 100000 + c; }

  static readonly Dictionary<string, int> ERRS = new Dictionary<string, int> { { "#DIV/0!", -2146826281 }, { "#N/A", -2146826246 }, { "#REF!", -2146826265 }, { "#VALUE!", -2146826273 } };
  static readonly Regex DateOnly = new Regex(@"^\d{4}-\d{2}-\d{2}$");

  // A seeded or written constant as Excel keeps it.
  static object Constant(object v) {
    var s = v as string;
    if (s != null) {
      int e;
      if (ERRS.TryGetValue(s, out e)) return e;
      if (DateOnly.IsMatch(s)) return DateTime.ParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture);
      return s;
    }
    if (v is int || v is long || v is decimal || v is float) return Convert.ToDouble(v, CultureInfo.InvariantCulture);
    return v;
  }

  // Formula text typed into a cell: a formula, a number, TRUE or FALSE, or text.
  static void Type(XCell c, string s) {
    c.F = ""; c.V = null;
    double d;
    if (s.StartsWith("=")) c.F = s;
    else if (s == "") c.V = null;
    else if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) c.V = d;
    else if (s == "TRUE" || s == "FALSE") c.V = s == "TRUE";
    else c.V = s;
  }

  XCell CellAt(XSheet s, int r, int c, bool make) {
    XCell x;
    if (s.Cells.TryGetValue(K(r, c), out x)) return x;
    if (!make) return null;
    x = new XCell(); s.Cells[K(r, c)] = x; return x;
  }

  void Changed(XSheet s, int[] b) {
    if (sheetChange != null) sheetChange.DynamicInvoke(SheetObj(s), RangeObj(s, b));
  }

  object Block(XSheet s, int[] b, Func<XCell, object> of) {
    int rows = b[2] - b[0] + 1, cols = b[3] - b[1] + 1;
    if (rows == 1 && cols == 1) return of(CellAt(s, b[0], b[1], false));
    var a = Array.CreateInstance(typeof(object), new[] { rows, cols }, new[] { 1, 1 });
    for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) a.SetValue(of(CellAt(s, b[0] + i, b[1] + j, false)), i + 1, j + 1);
    return a;
  }

  void Fill(XSheet s, int[] b, object v, Action<XCell, object> put) {
    int rows = b[2] - b[0] + 1, cols = b[3] - b[1] + 1;
    var a = v as Array;
    for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) {
      object x = a == null ? v : a.GetValue(a.GetLowerBound(0) + i, a.GetLowerBound(1) + j);
      put(CellAt(s, b[0] + i, b[1] + j, true), x);
    }
    Changed(s, b);
  }

  static string FormulaOf(XCell c) {
    if (c == null) return "";
    if (c.F != "") return c.F;
    if (c.V == null) return "";
    if (c.V is bool) return (bool)c.V ? "TRUE" : "FALSE";
    if (c.V is double) return ((double)c.V).ToString("R", CultureInfo.InvariantCulture);
    if (c.V is DateTime) return ((DateTime)c.V).ToOADate().ToString(CultureInfo.InvariantCulture);
    return Convert.ToString(c.V, CultureInfo.InvariantCulture);
  }

  Obj RangeObj(XSheet s, int[] b) {
    var r = new Obj("Range");
    int rows = b[2] - b[0] + 1, cols = b[3] - b[1] + 1;
    // Excel's Value gives a date-formatted number as a DateTime.
    r.Prop("Value", () => Block(s, b, c => c == null ? null : c.V is double && c.Z.Contains("yy") ? (object)DateTime.FromOADate((double)c.V) : c.V))
      .Put("Value", v => Fill(s, b, v, (c, x) => { c.F = ""; c.V = x is string && ((string)x).StartsWith("=") ? null : Constant(x); if (x is string && ((string)x).StartsWith("=")) c.F = (string)x; }))
      .Put("Formula", v => Fill(s, b, v, (c, x) => Type(c, Convert.ToString(x, CultureInfo.InvariantCulture) ?? "")))
      .Prop("Formula", () => Block(s, b, FormulaOf))
      .Prop("NumberFormat", () => {
        string z = null; var same = true;
        for (var i = b[0]; i <= b[2]; i++) for (var j = b[1]; j <= b[3]; j++) { var c = CellAt(s, i, j, false); var f = c == null ? "General" : c.Z; if (z == null) z = f; else if (z != f) same = false; }
        return same ? z : null;
      })
      .Put("NumberFormat", v => { for (var i = b[0]; i <= b[2]; i++) for (var j = b[1]; j <= b[3]; j++) CellAt(s, i, j, true).Z = (string)v; })
      .Fn("Address", a => {
        var abs = a.Length == 0 || Convert.ToBoolean(a[0]);
        Func<int, int, string> one = (row, col) => abs ? "$" + ColName(col) + "$" + row : ColName(col) + row;
        return rows == 1 && cols == 1 ? one(b[0], b[1]) : one(b[0], b[1]) + ":" + one(b[2], b[3]);
      })
      .Prop("Row", () => b[0]).Prop("Column", () => b[1])
      .Prop("Rows", () => new Obj("Rows").Prop("Count", () => rows).Fn("Item", a => RangeObj(s, new[] { b[0] + Convert.ToInt32(a[0]) - 1, b[1], b[0] + Convert.ToInt32(a[0]) - 1, b[3] })))
      .Prop("Columns", () => new Obj("Columns").Prop("Count", () => cols))
      .Prop("Cells", () => new Obj("Cells").Fn("Item", a => { int i = b[0] + Convert.ToInt32(a[0]) - 1, j = b[1] + Convert.ToInt32(a[1]) - 1; return RangeObj(s, new[] { i, j, i, j }); }));
    if (!oldExcel) {
      r.Prop("Formula2", () => Block(s, b, FormulaOf));
      r.Put("Formula2", v => Fill(s, b, v, (c, x) => Type(c, Convert.ToString(x, CultureInfo.InvariantCulture) ?? "")));
    }
    return r;
  }

  Obj SheetObj(XSheet s) {
    return new Obj("Worksheet").Prop("Name", () => s.Name).Prop("Parent", () => BookObj(s.Book))
      .Fn("Range", a => RangeObj(s, Parse((string)a[0])))
      .Prop("UsedRange", () => {
        var used = s.Cells.Where(kv => kv.Value.V != null || kv.Value.F != "").Select(kv => kv.Key).ToList();
        if (used.Count == 0) return RangeObj(s, new[] { 1, 1, 1, 1 });
        int r1 = (int)(used.Min(k => k / 100000)), r2 = (int)(used.Max(k => k / 100000)), c1 = (int)(used.Min(k => k % 100000)), c2 = (int)(used.Max(k => k % 100000));
        return RangeObj(s, new[] { r1, c1, r2, c2 });
      });
  }

  Obj Collection<T>(string kind, Func<List<T>> list, Func<T, Obj> of, Func<T, string, bool> named) {
    return new Obj(kind).Prop("Count", () => list().Count).Fn("Item", a => {
      var l = list();
      if (a[0] is string) { foreach (var x in l) if (named(x, (string)a[0])) return of(x); throw Err(E_BADINDEX, "Invalid index. (Exception from HRESULT: 0x8002000B (DISP_E_BADINDEX))"); }
      var i = Convert.ToInt32(a[0]);
      if (i < 1 || i > l.Count) throw Err(E_BADINDEX, "Invalid index. (Exception from HRESULT: 0x8002000B (DISP_E_BADINDEX))");
      return of(l[i - 1]);
    });
  }

  // One object per open workbook, as COM hands .NET the same wrapper for the same object.
  readonly Dictionary<XBook, Obj> bookObjs = new Dictionary<XBook, Obj>();
  Obj BookObj(XBook b) {
    Obj o;
    if (bookObjs.TryGetValue(b, out o)) return o;
    return bookObjs[b] = new Obj("Workbook").Prop("FullName", () => b.Key).Prop("Name", () => b.Name).Fn("Activate", a => { started.Add(Office.Obj("activate", b.Key)); return null; })
      .Prop("Worksheets", () => Collection<XSheet>("Sheets", () => b.Sheets, SheetObj, (x, n) => x.Name == n));
  }

  // ---- Word
  Obj WordRange(WDoc d, int[] span) {
    var r = new Obj("Range");
    r.Prop("Text", () => d.Text.Substring(span[0], span[1] - span[0]))
      .Put("Text", v => {
        var was = d.Text.Substring(span[0], span[1] - span[0]); var now = (string)v;
        d.Text = d.Text.Substring(0, span[0]) + now + d.Text.Substring(span[1]);
        span[1] = span[0] + now.Length;
        if (d.Track) d.Tracked.Add("-" + was + " +" + now);
      })
      .Fn("InsertBefore", a => { var t = (string)a[0]; d.Text = t + d.Text; if (d.Track) d.Tracked.Add("+" + t); return null; })
      // Word keeps the document's last paragraph mark last.
      .Fn("InsertAfter", a => { var t = (string)a[0]; var at = d.Text.EndsWith("\r") ? d.Text.Length - 1 : d.Text.Length; d.Text = d.Text.Substring(0, at) + t + d.Text.Substring(at); if (d.Track) d.Tracked.Add("+" + t); return null; })
      .Fn("Collapse", a => { if (Convert.ToInt32(a[0]) == 0) span[0] = span[1]; else span[1] = span[0]; return null; })
      .Prop("Start", () => span[0]).Prop("End", () => span[1])
      .Fn("SetRange", a => { span[0] = Convert.ToInt32(a[0]); span[1] = Convert.ToInt32(a[1]); return null; });
    var find = new Obj("Find"); string text = ""; bool matchCase = false;
    find.Put("Text", v => text = ((string)v).Replace("^^", "^")).Put("MatchCase", v => matchCase = Convert.ToBoolean(v)).Put("Forward", v => { }).Put("Wrap", v => { })
      .Fn("ClearFormatting", a => null);
    foreach (var flag in new[] { "Format", "MatchWildcards", "MatchWholeWord", "MatchSoundsLike", "MatchAllWordForms", "MatchPrefix", "MatchSuffix", "IgnoreSpace", "IgnorePunct" }) find.Put(flag, v => { if (Convert.ToBoolean(v)) throw Err(E_UNKNOWN, "not modelled"); });
    find
      .Fn("Execute", a => {
        // From the range on to the end of the document (wdFindStop); a hit becomes the range.
        var i = d.Text.IndexOf(text, span[0], matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase);
        if (i < 0) return false;
        span[0] = i; span[1] = i + text.Length; return true;
      });
    r.Prop("Find", () => find);
    return r;
  }

  // The window's markup and view while a find runs: 0 and 0 is the final text with no markup.
  int markupNow = 2, viewNow = 0;
  Obj filter { get { return new Obj("RevisionsFilter").Prop("Markup", () => markupNow).Put("Markup", v => markupNow = Convert.ToInt32(v)).Prop("View", () => viewNow).Put("View", v => viewNow = Convert.ToInt32(v)); } }

  Obj DocObj(WDoc d) {
    return new Obj("Document").Prop("FullName", () => d.Key).Prop("Name", () => d.Name)
      .Prop("TrackRevisions", () => d.Track).Put("TrackRevisions", v => d.Track = Convert.ToBoolean(v))
      .Prop("Content", () => WordRange(d, new[] { 0, d.Text.Length }))
      .Fn("Activate", a => { started.Add(Office.Obj("activate", d.Key)); return null; })
      .Prop("ActiveWindow", () => new Obj("Window").Prop("Hwnd", () => 202).Prop("View", () => new Obj("View").Prop("RevisionsFilter", () => filter)));
  }

  // ---- PowerPoint
  Obj TextRange(List<string> slide, int k) {
    return new Obj("TextRange").Prop("Text", () => slide[k]).Fn("Replace", a => {
      string find = (string)a[0], repl = (string)a[1]; var after = a.Length > 2 ? Convert.ToInt32(a[2]) : 0;
      var i = slide[k].IndexOf(find, Math.Min(after, slide[k].Length), StringComparison.Ordinal);
      if (i < 0) return null;
      slide[k] = slide[k].Substring(0, i) + repl + slide[k].Substring(i + find.Length);
      return new Obj("TextRange").Prop("Start", () => i + 1).Prop("Length", () => repl.Length);
    });
  }

  Obj SlideObj(List<string> slide) {
    // Each text is a placeholder with a text frame; a picture with none sits among them.
    var shapes = new List<Obj>();
    for (var k = 0; k < slide.Count; k++) {
      var at = k;
      shapes.Add(new Obj("Shape").Prop("HasTextFrame", () => -1).Prop("TextFrame", () => new Obj("TextFrame").Prop("TextRange", () => TextRange(slide, at))));
    }
    shapes.Add(new Obj("Shape").Prop("HasTextFrame", () => 0));
    return new Obj("Slide").Prop("Shapes", () => Collection<Obj>("Shapes", () => shapes, x => x, (x, n) => false));
  }

  Obj DeckObj(PDeck p) {
    return new Obj("Presentation").Prop("FullName", () => p.Key).Prop("Name", () => p.Name)
      .Prop("Slides", () => Collection<List<string>>("Slides", () => p.Slides, SlideObj, (x, n) => false))
      .Fn("Activate", a => { started.Add(Office.Obj("activate", p.Key)); return null; })
      .Prop("Windows", () => new Obj("Windows").Fn("Item", a => new Obj("Window").Prop("HWND", () => 303)));
  }

  // ---- Outlook
  const string PR_SMTP = "http://schemas.microsoft.com/mapi/proptag/0x39FE001F", PR_SENDER_SMTP = "http://schemas.microsoft.com/mapi/proptag/0x5D01001F";

  Obj Accessor(Func<string, object> prop) {
    return new Obj("PropertyAccessor").Fn("GetProperty", a => {
      if (guard) throw Err(E_ABORT, "Operation aborted (Exception from HRESULT: 0x80004004 (E_ABORT))");
      var v = prop((string)a[0]);
      if (v == null) throw Err(unchecked((int)0x8004010F), "The property \"" + a[0] + "\" is unknown or cannot be found.");
      return v;
    });
  }

  Obj RecipientObj(object[] r) {
    // r: { address, type }
    return new Obj("Recipient").Prop("Type", () => r[1]).Prop("Resolved", () => ((string)r[0]).Contains("@")).Put("Type", v => r[1] = Convert.ToInt32(v)).Prop("Name", () => r[0])
      .Prop("PropertyAccessor", () => Accessor(t => t == PR_SMTP ? r[0] : null))
      .Prop("AddressEntry", () => new Obj("AddressEntry").Prop("Address", () => r[0]).Fn("GetExchangeUser", a => null));
  }

  Obj Recipients(List<object[]> list) {
    return new Obj("Recipients").Prop("Count", () => list.Count)
      .Fn("Item", a => RecipientObj(list[Convert.ToInt32(a[0]) - 1]))
      .Fn("Add", a => { var r = new object[] { (string)a[0], 1 }; list.Add(r); return RecipientObj(r); })
      .Fn("Remove", a => { list.RemoveAt(Convert.ToInt32(a[0]) - 1); return null; })
      .Fn("ResolveAll", a => list.All(r => ((string)r[0]).Contains("@")));
  }

  static string Of(List<object[]> rs, int type, string sep) { return string.Join(sep, rs.Where(r => Convert.ToInt32(r[1]) == type).Select(r => (string)r[0]).ToArray()); }

  Obj MailObj(OMail m) {
    var o = new Obj("MailItem");
    o.Prop("EntryID", () => m.Id).Prop("Class", () => m.Class).Prop("Subject", () => m.Subject).Put("Subject", v => m.Subject = (string)v)
      .Prop("Body", () => m.Text).Put("Body", v => m.Text = (string)v).Prop("HTMLBody", () => m.Html).Put("HTMLBody", v => m.Html = (string)v)
      .Prop("SenderEmailType", () => "SMTP").Prop("SenderEmailAddress", () => m.From)
      .Prop("Sender", () => new Obj("AddressEntry").Prop("Address", () => m.From).Fn("GetExchangeUser", a => null))
      .Prop("ReceivedTime", () => m.Folder == "inbox" ? m.At : new DateTime(4501, 1, 1)).Prop("SentOn", () => m.Folder == "sent" ? m.At : new DateTime(4501, 1, 1)).Prop("LastModificationTime", () => m.At)
      .Prop("UnRead", () => !m.Read).Prop("Recipients", () => Recipients(m.Recipients))
      .Prop("PropertyAccessor", () => Accessor(t => t == PR_SENDER_SMTP ? m.From : null))
      .Prop("Parent", () => FolderObj(m.Folder, m.Account))
      .Put("SendUsingAccount", v => m.SendUsing = v)
      .Fn("Reply", a => {
        // As Outlook does: a reply is addressed to the mail's Reply-To when it has one, else to its sender.
        var r = Draft(m.Account); r.Subject = "RE: " + m.Subject; r.Recipients.Add(new object[] { m.ReplyTo ?? m.From, 1 });
        r.Html = "<html><head></head><body><div class=quote>From: " + m.From + "<br>" + m.Text + "</div></body></html>"; return MailObj(r);
      })
      .Fn("Forward", a => {
        var r = Draft(m.Account); r.Subject = "FW: " + m.Subject;
        r.Html = "<html><head></head><body><div class=quote>From: " + m.From + "<br>" + m.Text + "</div></body></html>"; return MailObj(r);
      })
      .Fn("Save", a => { if (!mail.Contains(m)) { m.Folder = "drafts"; mail.Add(m); } return null; })
      .Fn("Delete", a => { mail.Remove(m); thrownAway.Add(m.Subject); return null; })
      .Fn("Send", a => {
        var acc = m.SendUsing == null ? accounts.FirstOrDefault() : (string)Raw(m.SendUsing, "SmtpAddress");
        sent.Add(Office.Obj("account", acc, "to", Of(m.Recipients, 1, ";"), "cc", Of(m.Recipients, 2, ";"), "bcc", Of(m.Recipients, 3, ";"), "subject", m.Subject, "html", m.Html));
        mail.Remove(m); m.Folder = "sent"; m.At = DateTime.Now; m.Account = acc; mail.Add(m); return null;
      });
    return o;
  }

  OMail Draft(string account) { return new OMail { Id = "00000000" + (nextId++), Account = account ?? accounts.FirstOrDefault(), At = DateTime.Now, Folder = "new" }; }

  Obj EventObj(OEvent e) {
    return new Obj("AppointmentItem").Prop("EntryID", () => e.Id).Prop("Class", () => 26)
      .Prop("Subject", () => e.Subject).Put("Subject", v => e.Subject = (string)v)
      .Prop("Start", () => e.Start).Put("Start", v => e.Start = (DateTime)v).Prop("End", () => e.End).Put("End", v => e.End = (DateTime)v)
      .Prop("Location", () => e.Location).Put("Location", v => e.Location = (string)v).Put("Body", v => e.Body = (string)v)
      .Prop("Organizer", () => e.Organizer).Prop("ResponseStatus", () => e.Response).Prop("GlobalAppointmentID", () => e.Global)
      .Put("MeetingStatus", v => e.Meeting = Convert.ToInt32(v)).Prop("Recipients", () => Recipients(e.Recipients))
      .Fn("Save", a => { if (!events.Contains(e)) events.Add(e); return null; })
      // Sending an invitation saves the meeting, as Outlook does.
      .Fn("Send", a => { if (!events.Contains(e)) events.Add(e); sent.Add(Office.Obj("invite", e.Subject, "to", Of(e.Recipients, 1, ";"), "meeting", e.Meeting)); return null; })
      .Fn("Respond", a => {
        var answer = Convert.ToInt32(a[0]); var noUi = a.Length > 1 && Convert.ToBoolean(a[1]);
        var reply = Office.Obj("id", e.Id, "response", answer, "noUi", noUi, "sent", false, "body", "");
        answers.Add(reply);
        return new Obj("MeetingItem").Put("Body", v => reply["body"] = v).Fn("Send", x => { reply["sent"] = true; e.Response = answer; return null; });
      });
  }

  static readonly Regex Subject = new Regex("like '%(.*)%'$"), StartFilter = new Regex(@"^\[Start\] >= '(.+)' AND \[Start\] < '(.+)'$");

  Obj ItemsObj(Func<List<object>> all) {
    List<object> list = null; var at = 0;
    Func<List<object>> items = () => list ?? (list = all());
    var o = new Obj("Items");
    o.Prop("Count", () => items().Count).Fn("Item", a => items()[Convert.ToInt32(a[0]) - 1])
      .Put("IncludeRecurrences", v => { })
      .Fn("Sort", a => {
        var key = (string)a[0]; var desc = a.Length > 1 && Convert.ToBoolean(a[1]);
        Func<object, DateTime> when = x => (DateTime)Raw(x, key.Trim('[', ']'));
        list = (desc ? items().OrderByDescending(when) : items().OrderBy(when)).ToList(); return null;
      })
      .Fn("Restrict", a => {
        var f = (string)a[0];
        var s = Subject.Match(f); var t = StartFilter.Match(f);
        if (s.Success) { var q = s.Groups[1].Value.Replace("''", "'"); return ItemsObj(() => items().Where(x => ((string)Raw(x, "Subject")).IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0).ToList()); }
        if (t.Success) {
          DateTime from = DateTime.Parse(t.Groups[1].Value, CultureInfo.CurrentCulture), to = DateTime.Parse(t.Groups[2].Value, CultureInfo.CurrentCulture);
          return ItemsObj(() => items().Where(x => { var d = (DateTime)Raw(x, "Start"); return d >= from && d < to; }).ToList());
        }
        throw Err(unchecked((int)0x80020009), "Cannot parse condition. Error at \"" + f + "\".");
      })
      .Fn("GetFirst", a => { at = 0; return at < items().Count ? items()[at] : null; })
      .Fn("GetNext", a => { at++; return at < items().Count ? items()[at] : null; })
      .Fn("Add", a => { var e = new OEvent { Id = "0000AA" + (nextId++), Organizer = accounts.FirstOrDefault() ?? "", Global = "040000008200E00074C5B7101A82E008" + (nextId++).ToString("X8") }; return EventObj(e); });
    return o;
  }

  Obj FolderObj(string name, string account) {
    var store = new Obj("Store").Prop("StoreID", () => "store:" + (account ?? accounts.FirstOrDefault()));
    if (name == "calendar") return new Obj("Folder").Prop("Store", () => store).Prop("Items", () => ItemsObj(() => events.Select(e => (object)EventObj(e)).ToList()));
    return new Obj("Folder").Prop("Store", () => store).Prop("Items", () => ItemsObj(() => mail.Where(m => m.Folder == name).Select(m => (object)MailObj(m)).ToList()));
  }

  static string FolderOf(object n) { var i = Convert.ToInt32(n); return i == 6 ? "inbox" : i == 5 ? "sent" : i == 16 ? "drafts" : i == 9 ? "calendar" : "other"; }

  Obj AccountObj(string address) {
    return new Obj("Account").Prop("SmtpAddress", () => address)
      .Prop("DeliveryStore", () => new Obj("Store").Prop("StoreID", () => "store:" + address).Fn("GetDefaultFolder", a => FolderObj(FolderOf(a[0]), address)));
  }

  Obj Namespace() {
    return new Obj("NameSpace")
      .Prop("Accounts", () => Collection<string>("Accounts", () => accounts, AccountObj, (x, n) => x == n))
      .Fn("GetDefaultFolder", a => FolderObj(FolderOf(a[0]), null))
      .Fn("GetItemFromID", a => {
        var id = (string)a[0];
        var m = mail.FirstOrDefault(x => x.Id == id); if (m != null) return MailObj(m);
        var e = events.FirstOrDefault(x => x.Id == id); if (e != null) return EventObj(e);
        throw Err(unchecked((int)0x8004010F), "The operation failed. An object could not be found.");
      });
  }

  // ---- the apps, built afresh from a seed
  void Seed(Dictionary<string, object> s) {
    foreach (var app in new[] { "excel", "word", "powerpoint", "outlook" }) { installed[app] = true; running[app] = true; visible[app] = true; }
    var apps = s.ContainsKey("apps") ? (Dictionary<string, object>)s["apps"] : new Dictionary<string, object>();
    foreach (var kv in apps) {
      var a = (Dictionary<string, object>)kv.Value;
      if (a.ContainsKey("installed")) installed[kv.Key] = Convert.ToBoolean(a["installed"]);
      if (a.ContainsKey("running")) running[kv.Key] = Convert.ToBoolean(a["running"]);
      if (a.ContainsKey("visible")) visible[kv.Key] = Convert.ToBoolean(a["visible"]);
    }
    oldExcel = s.ContainsKey("oldExcel") && Convert.ToBoolean(s["oldExcel"]);
    guard = s.ContainsKey("guard") && Convert.ToBoolean(s["guard"]);
    // The apps stay the same objects across seeds, as a running Office does, and so does an event handler given to Excel.
    busy = 0; failMember = null;
    // Seeded books are opened afresh: new objects, with no handlers of the old ones.
    bookObjs.Clear(); remote.Clear();
    books.Clear(); docs.Clear(); decks.Clear(); accounts.Clear(); mail.Clear(); events.Clear(); sent.Clear(); thrownAway.Clear(); answers.Clear(); started.Clear(); calls.Clear();
    foreach (Dictionary<string, object> b in List(s, "books")) {
      var book = new XBook { Key = (string)b["key"], Name = Leaf((string)b["key"]) };
      foreach (var sh in (Dictionary<string, object>)b["sheets"]) {
        var sheet = new XSheet { Name = sh.Key, Book = book };
        foreach (var c in (Dictionary<string, object>)sh.Value) {
          var at = Parse(c.Key); var cell = CellAt(sheet, at[0], at[1], true);
          var v = c.Value as string;
          if (v != null && v.StartsWith("=")) cell.F = v; else cell.V = Constant(c.Value);
          if (cell.V is DateTime) cell.Z = "yyyy-mm-dd";
        }
        book.Sheets.Add(sheet);
      }
      books.Add(book);
    }
    foreach (Dictionary<string, object> d in List(s, "docs")) docs.Add(new WDoc { Key = (string)d["key"], Name = Leaf((string)d["key"]), Text = string.Join("\r", ((ArrayList)d["paragraphs"]).Cast<string>().ToArray()) + "\r" });
    foreach (Dictionary<string, object> p in List(s, "decks")) {
      var deck = new PDeck { Key = (string)p["key"], Name = Leaf((string)p["key"]) };
      foreach (ArrayList slide in (ArrayList)p["slides"]) deck.Slides.Add(slide.Cast<string>().ToList());
      decks.Add(deck);
    }
    foreach (string a in List(s, "accounts")) accounts.Add(a);
    foreach (Dictionary<string, object> m in List(s, "mail")) {
      var x = new OMail { Id = (string)m["id"], Account = (string)m["account"], From = (string)m["from"], Subject = (string)m["subject"], Text = m.ContainsKey("text") ? (string)m["text"] : "",
        At = DateTime.Parse((string)m["at"], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToLocalTime(), Read = !m.ContainsKey("read") || Convert.ToBoolean(m["read"]), Folder = m.ContainsKey("folder") ? (string)m["folder"] : "inbox", ReplyTo = m.ContainsKey("replyTo") ? (string)m["replyTo"] : null };
      foreach (string t in List(m, "to")) x.Recipients.Add(new object[] { t, 1 });
      foreach (string t in List(m, "cc")) x.Recipients.Add(new object[] { t, 2 });
      mail.Add(x);
    }
    foreach (Dictionary<string, object> e in List(s, "events")) {
      var x = new OEvent { Id = (string)e["id"], Subject = (string)e["subject"], Organizer = e.ContainsKey("organizer") ? (string)e["organizer"] : "", Global = e.ContainsKey("global") ? (string)e["global"] : "",
        Start = DateTime.Parse((string)e["start"], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToLocalTime(), End = DateTime.Parse((string)e["end"], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToLocalTime(),
        Response = e.ContainsKey("response") ? Convert.ToInt32(e["response"]) : 0 };
      foreach (string t in List(e, "attendees")) x.Recipients.Add(new object[] { t, 1 });
      events.Add(x);
    }
    if (excel != null) return;
    excel = new Obj("Excel.Application").Prop("Version", () => oldExcel ? "16.0 (2016)" : "16.0").Prop("Hwnd", () => 101).Put("Visible", v => { }).Prop("Visible", () => visible["excel"])
      .Prop("Workbooks", () => Collection<XBook>("Workbooks", () => books, BookObj, (b, n) => b.Key == n || b.Name == n));
    word = new Obj("Word.Application").Prop("Version", () => "16.0").Put("Visible", v => { }).Prop("Visible", () => visible["word"])
      .Prop("Documents", () => Collection<WDoc>("Documents", () => docs, DocObj, (d, n) => d.Key == n || d.Name == n));
    powerpoint = new Obj("PowerPoint.Application").Prop("Version", () => "16.0").Prop("Visible", () => visible["powerpoint"] ? -1 : 0)
      .Prop("Presentations", () => Collection<PDeck>("Presentations", () => decks, DeckObj, (p, n) => p.Key == n || p.Name == n));
    outlook = new Obj("Outlook.Application").Prop("Version", () => "16.0.0.0")
      .Prop("Explorers", () => new Obj("Explorers").Prop("Count", () => visible["outlook"] ? 1 : 0)).Prop("Inspectors", () => new Obj("Inspectors").Prop("Count", () => 0))
      .Fn("GetNamespace", a => Namespace())
      .Fn("CreateItem", a => { if (Convert.ToInt32(a[0]) != 0) throw Err(E_UNKNOWN, "only mail here"); return MailObj(Draft(null)); });
  }

  static string Leaf(string key) { var i = Math.Max(key.LastIndexOf('\\'), key.LastIndexOf('/')); return i < 0 ? key : key.Substring(i + 1); }
  static IEnumerable List(Dictionary<string, object> o, string key) { return o.ContainsKey(key) && o[key] != null ? (IEnumerable)o[key] : new object[0]; }

  // ---- the test verbs
  public object Test(string verb, Dictionary<string, object> a, Office office) {
    switch (verb) {
      case "_seed": Seed(a); return null;
      case "_busy": busy = Convert.ToInt32(a["calls"]); return null;
      case "_fail": failMember = (string)a["member"]; failCode = (int)Convert.ToUInt32((string)a["hresult"], 16); return null;
      case "_type": {
        // Someone typed in Excel: the cell changes and SheetChange fires, as it would for him.
        var book = books.First(b => b.Key == (string)a["book"]);
        var sheet = book.Sheets.First(x => x.Name == (string)a["sheet"]);
        var at = Parse((string)a["cell"]);
        var c = CellAt(sheet, at[0], at[1], true); c.F = ""; c.V = Constant(a["value"]);
        Changed(sheet, at);
        return null;
      }
      case "_merge": {
        // A co-author's edit merged in: the cell changes, SheetChange stays quiet, AfterRemoteChange fires.
        var book = books.First(b => b.Key == (string)a["book"]);
        var at = Parse((string)a["cell"]);
        var c = CellAt(book.Sheets.First(x => x.Name == (string)a["sheet"]), at[0], at[1], true); c.F = ""; c.V = Constant(a["value"]);
        Delegate d;
        if (remote.TryGetValue(book.Key, out d)) d.DynamicInvoke();
        return null;
      }
      case "_state":
        return Office.Obj("sent", sent, "thrownAway", thrownAway, "answers", answers, "started", started, "calls", calls, "markup", markupNow,
          "drafts", mail.Where(m => m.Folder == "drafts").Select(m => (object)Office.Obj("id", m.Id, "subject", m.Subject, "html", m.Html, "to", Of(m.Recipients, 1, ";"))).ToList(),
          "docs", docs.Select(d => (object)Office.Obj("key", d.Key, "text", d.Text, "tracked", d.Tracked)).ToList(),
          "decks", decks.Select(p => (object)Office.Obj("key", p.Key, "slides", p.Slides)).ToList(),
          "events", events.Select(e => (object)Office.Obj("id", e.Id, "subject", e.Subject, "meeting", e.Meeting, "attendees", Of(e.Recipients, 1, ";"))).ToList());
    }
    throw new Refusal("failed", "no test verb " + verb);
  }
}
}
