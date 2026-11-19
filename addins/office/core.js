/*
 * TempCode's Office add-in, its working part (docs/agents/work-office.md "The add-in").
 * Plain script, no build: Office loads it in the pane beside a workbook,
 * document or deck, and the box's tests run it in a sandbox against a stub
 * Office.js. It connects out to the relay at `wss://<this origin>/w/office`,
 * says hello with its own key (or pairs once with the code TempCode shows),
 * then answers TempCode's calls on the open file and reports each change to a
 * workbook by its range.
 */
;(function (root) {
  'use strict'

  var KEY = 'tempcode.addin.key'

  function createAddin(env) {
    var Office = env.Office
    var state = { phase: 'idle', words: '' }
    var ws = null
    var stopped = false
    var wait = 1000
    var timer = null
    var app = hostApp()
    var offChanged = null

    function hostApp() {
      var h = Office.context.host
      return h === Office.HostType.Excel ? 'excel' : h === Office.HostType.Word ? 'word' : h === Office.HostType.PowerPoint ? 'powerpoint' : 'other'
    }
    function platform() {
      var p = Office.context.diagnostics && Office.context.diagnostics.platform
      return p === 'OfficeOnline' ? 'web' : p === 'Mac' ? 'mac' : p === 'PC' ? 'windows' : String(p || 'unknown').toLowerCase()
    }
    /** What TempCode lists it as: "Excel on the web", "Word on Mac". */
    function label() {
      var names = { excel: 'Excel', word: 'Word', powerpoint: 'PowerPoint' }
      var where = { web: 'the web', mac: 'Mac', windows: 'Windows' }
      return (names[app] || 'Office') + ' on ' + (where[platform()] || platform())
    }
    function fileKey() {
      return Office.context.document.url || ''
    }
    function fileName() {
      var k = fileKey()
      var last = k.split(/[\\/]/).pop() || k
      try {
        return decodeURIComponent(last.split('?')[0])
      } catch (e) {
        return last
      }
    }
    function set(phase, words) {
      state = { phase: phase, words: words || '' }
      if (env.onState) env.onState(state)
    }
    function send(msg) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
    }

    // ── the open file ─────────────────────────────────────────────────
    function sheetsOf(context) {
      var sheets = context.workbook.worksheets
      sheets.load('items/name')
      return context.sync().then(function () {
        var used = sheets.items.map(function (s) {
          var u = s.getUsedRangeOrNullObject(true)
          u.load('isNullObject,rowIndex,columnIndex,rowCount,columnCount')
          return u
        })
        return context.sync().then(function () {
          return sheets.items.map(function (s, i) {
            var u = used[i]
            return { name: s.name, rows: u.isNullObject ? 0 : u.rowIndex + u.rowCount, columns: u.isNullObject ? 0 : u.columnIndex + u.columnCount }
          })
        })
      })
    }
    function fileInfo() {
      var file = { key: fileKey(), name: fileName() }
      if (app !== 'excel') return Promise.resolve({ t: 'file', app: app, file: file })
      return env.Excel.run(function (context) {
        return sheetsOf(context)
      }).then(function (sheets) {
        return { t: 'file', app: app, file: file, sheets: sheets }
      })
    }

    var ops = {
      'excel.read': function (a) {
        return env.Excel.run(function (context) {
          var r = context.workbook.worksheets.getItem(a.sheet).getRange(a.address)
          r.load('values,formulas,numberFormat')
          return context.sync().then(function () {
            return {
              values: r.values.map(function (row) {
                return row.map(function (v) {
                  return v === '' ? null : v
                })
              }),
              formulas: r.formulas.map(function (row) {
                return row.map(function (f) {
                  return typeof f === 'string' && f.charAt(0) === '=' ? f : ''
                })
              }),
              formats: r.numberFormat.map(function (row) {
                return row.map(function (z) {
                  return String(z)
                })
              })
            }
          })
        })
      },
      'excel.write': function (a) {
        return env.Excel.run(function (context) {
          var r = context.workbook.worksheets.getItem(a.sheet).getRange(a.address)
          // A value is written as a constant, a string starting with `=` as a formula; null empties the cell.
          r.formulas = a.grid.map(function (row) {
            return row.map(function (v) {
              return v === null ? '' : v
            })
          })
          return context.sync().then(function () {
            return null
          })
        })
      },
      'excel.workbook': function () {
        return fileInfo()
      },
      'word.read': function () {
        return env.Word.run(function (context) {
          var ps = context.document.body.paragraphs
          ps.load('items/text')
          return context.sync().then(function () {
            return ps.items.map(function (p) {
              return p.text
            })
          })
        })
      },
      'word.edit': function (a) {
        return env.Word.run(function (context) {
          var doc = context.document
          doc.load('changeTrackingMode')
          return context.sync().then(function () {
            var was = doc.changeTrackingMode
            if (a.tracked) doc.changeTrackingMode = env.Word.ChangeTrackingMode.trackAll
            var body = doc.body
            if ('insert' in a.edit) {
              body.insertText(a.edit.insert, a.edit.at === 'start' ? 'Start' : 'End')
              if (a.tracked) doc.changeTrackingMode = was
              return context.sync().then(function () {
                return 1
              })
            }
            var found = body.search(a.edit.find, { matchCase: true })
            found.load('items')
            return context.sync().then(function () {
              found.items.forEach(function (r) {
                r.insertText(a.edit.replace, 'Replace')
              })
              if (a.tracked) doc.changeTrackingMode = was
              return context.sync().then(function () {
                return found.items.length
              })
            })
          })
        })
      },
      'slides.read': function () {
        return slideTexts().then(function (s) {
          return s.map(function (x) {
            return { index: x.index, texts: x.ranges.map(function (r) { return r.text }) }
          })
        })
      },
      'slides.replace': function (a) {
        return env.PowerPoint.run(function (context) {
          return slideTexts(context).then(function (slides) {
            var n = 0
            slides.forEach(function (s) {
              s.ranges.forEach(function (r) {
                if (a.find && r.text.indexOf(a.find) >= 0) {
                  r.range.text = r.text.split(a.find).join(a.replace)
                  n++
                }
              })
            })
            return context.sync().then(function () {
              return n
            })
          })
        })
      }
    }

    function slideTexts(given) {
      var go = function (context) {
        var slides = context.presentation.slides
        slides.load('items')
        return context.sync().then(function () {
          var shapesOf = slides.items.map(function (s) {
            s.shapes.load('items/textFrame/hasText')
            return s.shapes
          })
          return context.sync().then(function () {
            var ranges = shapesOf.map(function (shapes) {
              return shapes.items
                .filter(function (sh) {
                  return sh.textFrame.hasText
                })
                .map(function (sh) {
                  var r = sh.textFrame.textRange
                  r.load('text')
                  return r
                })
            })
            return context.sync().then(function () {
              return ranges.map(function (rs, i) {
                return { index: i + 1, ranges: rs.map(function (r) { return { range: r, text: r.text } }) }
              })
            })
          })
        })
      }
      return given ? go(given) : env.PowerPoint.run(go)
    }

    function call(m) {
      var op = ops[m.op]
      if (!op) return send({ t: 'result', id: m.id, error: 'This add-in cannot do ' + m.op + '.' })
      Promise.resolve()
        .then(function () {
          return op(m.args || {})
        })
        .then(
          function (value) {
            send({ t: 'result', id: m.id, value: value === undefined ? null : value })
          },
          function (err) {
            send({ t: 'result', id: m.id, error: String((err && (err.message || err.code)) || err).slice(0, 500) })
          }
        )
    }

    // ── changes, by range ─────────────────────────────────────────────
    function watch() {
      if (app !== 'excel' || offChanged) return Promise.resolve()
      var names = {}
      function nameOf(id) {
        if (names[id]) return Promise.resolve(names[id])
        return env.Excel.run(function (context) {
          var sheets = context.workbook.worksheets
          sheets.load('items/id,items/name')
          return context.sync().then(function () {
            sheets.items.forEach(function (s) {
              names[s.id] = s.name
            })
            return names[id] || ''
          })
        })
      }
      return env.Excel.run(function (context) {
        var sheets = context.workbook.worksheets
        // Our own writes come back as changes too; TempCode knows those already.
        var changed = sheets.onChanged.add(function (e) {
          if (e.triggerSource === 'ThisLocalAddin') return
          nameOf(e.worksheetId).then(function (sheet) {
            send({ t: 'changed', sheet: sheet, address: e.address, source: e.source, change: e.changeType })
          })
        })
        var outline = function () {
          names = {}
          return fileInfo().then(send)
        }
        var added = sheets.onAdded.add(outline)
        var deleted = sheets.onDeleted.add(outline)
        return context.sync().then(function () {
          offChanged = [changed, added, deleted]
        })
      })
    }

    // ── the connection ────────────────────────────────────────────────
    function connect(first) {
      clearTimeout(timer)
      set('connecting', 'Connecting to TempCode…')
      var sock = new env.WebSocket(env.url)
      ws = sock
      sock.onopen = function () {
        sock.send(JSON.stringify(first))
      }
      sock.onmessage = function (ev) {
        var m
        try {
          m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        } catch (e) {
          return
        }
        if (m.t === 'paired') {
          env.storage.setItem(KEY, m.key)
          return
        }
        if (m.t === 'welcome') {
          wait = 1000
          set('connected', 'Connected to TempCode')
          fileInfo()
            .then(send)
            .then(watch)
            .catch(function (err) {
              set('connected', 'Connected, but this file could not be read: ' + (err && err.message))
            })
          return
        }
        if (m.t === 'call') call(m)
      }
      sock.onclose = function (ev) {
        if (ws !== sock) return
        ws = null
        if (stopped) return
        if (ev.code === 4403) {
          env.storage.removeItem(KEY)
          return set('unpaired', ev.reason || 'TempCode does not know this add-in. Pair it again.')
        }
        if (first.t === 'pair' && !env.storage.getItem(KEY)) return set('unpaired', ev.reason || 'That code did not work. Ask TempCode for a new one.')
        set('offline', 'TempCode is not answering. Trying again…')
        timer = setTimeout(start, wait)
        wait = Math.min(wait * 2, 30000)
      }
    }

    function hello() {
      return { t: 'hello', key: env.storage.getItem(KEY), app: app, platform: platform() }
    }

    function start() {
      stopped = false
      if (!env.storage.getItem(KEY)) return set('unpaired', '')
      connect(hello())
    }

    return {
      start: start,
      /** Pairs with the short code TempCode shows; the key it gets back stays in this pane's storage. */
      pair: function (code, name) {
        stopped = false
        connect({ t: 'pair', code: String(code).trim().toUpperCase(), name: name || label(), app: app, platform: platform() })
      },
      stop: function () {
        stopped = true
        clearTimeout(timer)
        if (ws) ws.close(1000, 'closed')
      },
      state: function () {
        return state
      }
    }
  }

  root.TempCodeAddin = { createAddin: createAddin }
})(typeof globalThis !== 'undefined' ? globalThis : this)
