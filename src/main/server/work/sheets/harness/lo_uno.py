"""Start a private headless LibreOffice and hand back its Desktop over UNO.

Run under LibreOffice's own Python: $LO/program/python. Each call gets a fresh
profile dir and pipe name, so many processes can run at once.
"""
import os, shutil, subprocess, tempfile, time, uuid

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.connection import NoConnectException

LO_PROGRAM = os.path.dirname(os.path.realpath(uno.__file__))
SOFFICE = os.path.join(LO_PROGRAM, "soffice")


def props(**kw):
    out = []
    for k, v in kw.items():
        p = PropertyValue()
        p.Name, p.Value = k, v
        out.append(p)
    return tuple(out)


def file_url(path):
    return uno.systemPathToFileUrl(os.path.abspath(path))


class Office:
    def __init__(self):
        self.profile = tempfile.mkdtemp(prefix="sheetlab-lo-")
        self.pipe = "sheetlab" + uuid.uuid4().hex
        env = dict(os.environ)
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        env["SAL_ENABLE_FILE_LOCKING"] = "0"  # never leave .~lock files next to corpus files
        self.proc = subprocess.Popen(
            [SOFFICE, "--headless", "--invisible", "--nologo", "--norestore", "--nodefault",
             "-env:UserInstallation=" + uno.systemPathToFileUrl(self.profile),
             "--accept=pipe,name=%s;urp;StarOffice.ComponentContext" % self.pipe],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext(
            "com.sun.star.bridge.UnoUrlResolver", local)
        deadline = time.time() + 60
        while True:
            try:
                self.ctx = resolver.resolve(
                    "uno:pipe,name=%s;urp;StarOffice.ComponentContext" % self.pipe)
                break
            except NoConnectException:
                if time.time() > deadline or self.proc.poll() is not None:
                    raise RuntimeError("soffice did not start")
                time.sleep(0.2)
        self.desktop = self.ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.Desktop", self.ctx)

    def load(self, path, **kw):
        doc = self.desktop.loadComponentFromURL(
            file_url(path), "_blank", 0, props(Hidden=True, ReadOnly=True, **kw))
        if doc is None:
            raise RuntimeError("LibreOffice could not open " + path)
        return doc

    def new_calc(self):
        return self.desktop.loadComponentFromURL(
            "private:factory/scalc", "_blank", 0, props(Hidden=True))

    def close(self):
        try:
            self.desktop.terminate()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=20)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def xlsx_filter(path):
    return "Calc MS Excel 2007 VBA XML" if path.lower().endswith(".xlsm") else "Calc Office Open XML"


def save_xlsx(doc, path):
    doc.storeToURL(file_url(path), props(FilterName=xlsx_filter(path), Overwrite=True))


def parse_value(s):
    try:
        return float(s)
    except ValueError:
        return s


def set_cell(doc, sheet, a1, value):
    sh = doc.Sheets.getByName(sheet)
    cell = sh.getCellRangeByName(a1)
    v = parse_value(value)
    if isinstance(v, float):
        cell.setValue(v)
    else:
        cell.setString(v)
