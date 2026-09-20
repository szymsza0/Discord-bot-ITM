/* =============================================================================
   ITM - webhook formularza Contact Form 7  (szablon dla komendy !webhook)
   -----------------------------------------------------------------------------
   Placeholdery podmieniane przez bota:
     __WEBHOOK_URL__  - URL webhooka (Make / Zapier / n8n / ...)
     __FORM_NAME__    - etykieta wysylana jako pole `_formularz`
     __PAGE_SLUG__    - fragment adresu, na ktorym skrypt ma dzialac
                        (pusty string = dziala na kazdej stronie)

   Wlasciwosci:
   - wysylka DOKLADNIE 1x na jedno poprawne wypelnienie formularza
     (guard przed podwojnym zaladowaniem + dedup identycznego payloadu w oknie 8s
      + reakcja wylacznie na `wpcf7mailsent`),
   - payload budowany w 100% dynamicznie ze WSZYSTKICH pol formularza,
   - rozroznienie instancji formularza na stronie:
       _formularz_nr      -> 1, 2, ...
       _formularz_sekcja  -> id najblizszego kontenera (np. "form-top" / "form-final").
   ========================================================================== */

(function () {
  "use strict";

  var WEBHOOK_URL = "__WEBHOOK_URL__";
  var FORM_NAME = "__FORM_NAME__";
  var PAGE_SLUG = "__PAGE_SLUG__";
  var DEDUP_MS = 8000;

  var GUARD_KEY = "__itmCf7Webhook_" + WEBHOOK_URL.split("/").pop();
  if (window[GUARD_KEY]) return;
  window[GUARD_KEY] = true;

  var snapshots = {};
  var lastSend = { sig: "", at: 0 };
  var SKIP_EXACT = { "g-recaptcha-response": 1, "_wpcf7_recaptcha_response": 1 };

  function isSkipped(name) {
    if (!name) return true;
    if (SKIP_EXACT[name]) return true;
    if (name.indexOf("_wpcf7") === 0) return true;
    return false;
  }

  function unitOf(form) {
    return form && form.closest ? form.closest(".wpcf7") : null;
  }
  function unitKey(form) {
    var unit = unitOf(form);
    return unit && unit.id ? unit.id : "wpcf7-default";
  }

  function instanceNr(unit) {
    var m = unit && unit.id && unit.id.match(/-o(\d+)(?:\b|$)/);
    if (m) return parseInt(m[1], 10);
    var all = Array.prototype.slice.call(document.querySelectorAll(".wpcf7"));
    var idx = unit ? all.indexOf(unit) : -1;
    return idx >= 0 ? idx + 1 : 1;
  }
  function sectionLabel(unit) {
    var node = unit ? unit.parentElement : null;
    while (node && node !== document.body) {
      if (node.id) return node.id;
      node = node.parentElement;
    }
    return "";
  }
  function tagUnit(data, unit) {
    if (!data) return data;
    data._formularz = data._formularz || FORM_NAME;
    data._formularz_nr = instanceNr(unit);
    data._formularz_sekcja = sectionLabel(unit);
    return data;
  }

  function collect(form) {
    var els = form.querySelectorAll("input[name], select[name], textarea[name]");
    var i, el, name, type;
    var counts = {};
    for (i = 0; i < els.length; i++) {
      name = els[i].name;
      if (isSkipped(name)) continue;
      counts[name] = (counts[name] || 0) + 1;
    }
    var data = {};
    for (i = 0; i < els.length; i++) {
      el = els[i];
      name = el.name;
      if (isSkipped(name)) continue;
      type = (el.type || "").toLowerCase();
      if (type === "checkbox") {
        if (counts[name] > 1) {
          if (el.checked) data[name] = data[name] ? data[name] + ", " + el.value : el.value;
          else if (data[name] === undefined) data[name] = "";
        } else {
          data[name] = el.checked ? "tak" : "nie";
        }
      } else if (type === "radio") {
        if (el.checked) data[name] = el.value;
        else if (data[name] === undefined) data[name] = "";
      } else if (el.tagName === "SELECT" && el.multiple) {
        var vals = [];
        for (var j = 0; j < el.options.length; j++) if (el.options[j].selected) vals.push(el.options[j].value);
        data[name] = vals.join(", ");
      } else {
        data[name] = (el.value || "").trim();
      }
    }
    data._formularz = FORM_NAME;
    data._page_url = window.location.href;
    data._timestamp = new Date().toISOString();
    return data;
  }

  function fromDetail(detail) {
    if (!detail || !detail.inputs) return null;
    var data = {};
    detail.inputs.forEach(function (inp) {
      if (isSkipped(inp.name)) return;
      if (data[inp.name] === undefined || data[inp.name] === "") data[inp.name] = inp.value;
      else if (inp.value) data[inp.name] += ", " + inp.value;
    });
    data._formularz = FORM_NAME;
    data._page_url = window.location.href;
    data._timestamp = new Date().toISOString();
    return data;
  }

  function signature(data) {
    return Object.keys(data)
      .filter(function (k) {
        return k !== "_timestamp";
      })
      .sort()
      .map(function (k) {
        return k + "=" + data[k];
      })
      .join("&");
  }

  function send(data) {
    if (!data) return;
    var sig = signature(data);
    var now = Date.now();
    if (sig === lastSend.sig && now - lastSend.at < DEDUP_MS) return;
    lastSend.sig = sig;
    lastSend.at = now;
    var params = new URLSearchParams();
    Object.keys(data).forEach(function (k) {
      params.append(k, data[k] == null ? "" : String(data[k]));
    });
    fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: params.toString(),
      mode: "no-cors",
      credentials: "omit",
      keepalive: true,
    }).catch(function (e) {
      console.warn("[itm-webhook] blad wysylki:", e);
    });
  }

  function init() {
    if (PAGE_SLUG && window.location.href.indexOf(PAGE_SLUG) === -1) return;

    document.addEventListener(
      "submit",
      function (e) {
        var form = e.target;
        if (!form || !form.classList || !form.classList.contains("wpcf7-form")) return;
        try {
          snapshots[unitKey(form)] = collect(form);
        } catch (err) {
          /* ignore */
        }
      },
      true
    );

    ["wpcf7invalid", "wpcf7spam", "wpcf7mailfailed"].forEach(function (evt) {
      document.addEventListener(
        evt,
        function (e) {
          var unit = e.target;
          var form = unit && unit.querySelector ? unit.querySelector(".wpcf7-form") : null;
          delete snapshots[form ? unitKey(form) : (unit && unit.id) || "wpcf7-default"];
        },
        false
      );
    });

    document.addEventListener(
      "wpcf7mailsent",
      function (e) {
        var unit = e.target;
        var form = unit && unit.querySelector ? unit.querySelector(".wpcf7-form") : null;
        var key = form ? unitKey(form) : (unit && unit.id) || "wpcf7-default";
        var data = snapshots[key] || fromDetail(e.detail) || (form ? collect(form) : null);
        delete snapshots[key];
        tagUnit(data, unit);
        send(data);
      },
      false
    );
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
