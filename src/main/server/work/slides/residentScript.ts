/**
 * The driver of the resident LibreOffice (resident.ts), run by LibreOffice's
 * own bundled Python as a separate process. It starts soffice with the argv
 * it is given (the hardened options and a UNO listener on a pipe), connects
 * over that pipe, then reads one JSON request a line on stdin and answers
 * each with one JSON line on stdout:
 *
 *   in   {"id": 1, "input": "/abs/in.pptx", "output": "/abs/out.pdf", "page": 3}   (page null: the whole deck)
 *   out  {"id": 1, "ok": true, "slides": 50, "open": 0.21, "export": 0.03}
 *   out  {"id": 1, "error": "…"}
 *
 * The first line out is {"ready": true, "startup": s} or {"error": "…"}.
 * Each job opens the deck hidden, read-only, with macros never run, exports
 * it with impress_pdf_Export (hidden slides kept, so page n is slide n), and
 * closes it. At the end of stdin it ends soffice; when soffice ends on its
 * own the driver exits at once, so the host sees the crash.
 *
 * argv: [script, sofficeArgvJson, pipeName, startSeconds]
 */
export const RESIDENT_PY = String.raw`
import json, os, subprocess, sys, threading, time
import uno

def pv(name, value):
    p = uno.createUnoStruct('com.sun.star.beans.PropertyValue')
    p.Name, p.Value = name, value
    return p

def props(**kw):
    return tuple(pv(k, v) for k, v in kw.items())

def say(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()

def url(path):
    return uno.systemPathToFileUrl(os.path.abspath(path))

def connect(argv, pipe, limit):
    began = time.monotonic()
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ctx = uno.getComponentContext()
    resolver = ctx.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', ctx)
    while True:
        try:
            remote = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext')
            break
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError('soffice exited with ' + str(proc.returncode) + ' before it listened')
            if time.monotonic() - began > limit:
                proc.kill()
                raise RuntimeError('soffice did not listen within ' + str(limit) + ' s')
            time.sleep(0.025)
    desk = remote.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', remote)
    return proc, desk, time.monotonic() - began

def export(desk, req):
    began = time.monotonic()
    doc = desk.loadComponentFromURL(url(req['input']), '_blank', 0, props(
        Hidden=True, ReadOnly=True,
        UpdateDocMode=uno.Any('short', 0),        # NO_UPDATE: no link is refreshed
        MacroExecutionMode=uno.Any('short', 0)))  # NEVER_EXECUTE
    if doc is None:
        raise RuntimeError('LibreOffice could not open the deck')
    opened = time.monotonic()
    try:
        pages = doc.getDrawPages().getCount()
        page = req.get('page')
        data = {'ExportHiddenSlides': True}
        if page is not None:
            if page < 1 or page > pages:
                raise RuntimeError('the deck has ' + str(pages) + ' slides, not a slide ' + str(page))
            data['PageRange'] = str(page)
        doc.storeToURL(url(req['output']), props(
            FilterName='impress_pdf_Export', Overwrite=True,
            FilterData=uno.Any('[]com.sun.star.beans.PropertyValue', props(**data))))
        done = time.monotonic()
    finally:
        doc.close(True)
    return {'slides': pages, 'open': opened - began, 'export': done - opened}

def main():
    argv, pipe, limit = json.loads(sys.argv[1]), sys.argv[2], float(sys.argv[3])
    try:
        proc, desk, startup = connect(argv, pipe, limit)
    except Exception as e:
        say({'error': str(e)[:400]})
        sys.exit(2)
    # soffice gone while idle: leave at once, so the host starts afresh rather than learning it from the next job.
    closing = []
    threading.Thread(target=lambda: (proc.wait(), os._exit(0 if closing else 3)), daemon=True).start()
    # Whatever ends this loop (the end of stdin, or the host gone so that even an answer cannot be written),
    # soffice ends with it: it is never left running with nobody to drive it.
    try:
        say({'ready': True, 'startup': startup})
        for line in sys.stdin:
            req = None
            try:
                req = json.loads(line)
                answer = dict(id=req['id'], ok=True, **export(desk, req))
            except Exception as e:
                answer = {'id': req.get('id') if isinstance(req, dict) else None, 'error': (type(e).__name__ + ': ' + str(e))[:400]}
            say(answer)
    except (BrokenPipeError, OSError):
        pass
    finally:
        closing.append(True)
        try:
            desk.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()

main()
`
