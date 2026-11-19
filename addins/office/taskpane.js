/* The pane's screen: one status line, and the pairing code box until this add-in has a key. */
;(function () {
  'use strict'
  Office.onReady(function () {
    var status = document.getElementById('status')
    var form = document.getElementById('pair')
    var code = document.getElementById('code')
    var go = document.getElementById('go')
    var addin = TempCodeAddin.createAddin({
      Office: Office,
      Excel: typeof Excel !== 'undefined' ? Excel : undefined,
      Word: typeof Word !== 'undefined' ? Word : undefined,
      PowerPoint: typeof PowerPoint !== 'undefined' ? PowerPoint : undefined,
      WebSocket: WebSocket,
      storage: window.localStorage,
      url: (location.protocol === 'http:' ? 'ws://' : 'wss://') + location.host + '/w/office',
      onState: function (s) {
        var unpaired = s.phase === 'unpaired'
        status.textContent = unpaired ? s.words || 'Enter the code from TempCode → Settings → Work.' : s.words
        form.hidden = !unpaired
        if (unpaired) code.focus()
      }
    })
    code.addEventListener('input', function () {
      go.disabled = code.value.trim().length < 8
    })
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      go.disabled = true
      addin.pair(code.value)
      code.value = ''
    })
    addin.start()
  })
})()
