export const VERIFIED_STAY_OFFER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>HemmaBo verified stay offer</title>
<style>
  :root {
    color-scheme: light;
    --panel: #fffdfa;
    --ink: #163b35;
    --muted: #66716b;
    --line: rgba(22, 59, 53, 0.14);
    --accent: #0f5a4d;
    --soft: #f1eadf;
    --danger-soft: #f7eee8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 6px;
    background: transparent;
    color: var(--ink);
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  .shell {
    width: min(100%, 720px);
    margin: 0 auto;
    border: 1px solid var(--line);
    border-radius: 18px;
    overflow: hidden;
    background: var(--panel);
    box-shadow: 0 18px 45px rgba(30, 25, 18, 0.12);
  }
  .hero {
    position: relative;
    min-height: 236px;
    background:
      linear-gradient(180deg, rgba(9, 23, 20, 0.08), rgba(9, 23, 20, 0.78)),
      radial-gradient(circle at 18% 18%, rgba(233, 184, 114, 0.42), transparent 34%),
      linear-gradient(135deg, #e7dcc8, #8ba49a 48%, #294f47);
  }
  .hero img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 420ms ease;
  }
  .hero img.active { opacity: 1; }
  .hero::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(7, 18, 16, 0.02), rgba(7, 18, 16, 0.75));
  }
  .heroCopy {
    position: absolute;
    left: 18px;
    right: 18px;
    bottom: 16px;
    z-index: 1;
    color: #fff;
    display: grid;
    gap: 8px;
  }
  .verifiedPill {
    justify-self: start;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.9);
    color: var(--ink);
    font-size: 12px;
    font-weight: 700;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #22c55e;
    box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.18);
  }
  h1 {
    margin: 0;
    max-width: 560px;
    font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
    font-size: 34px;
    line-height: 1.05;
    letter-spacing: 0;
    text-shadow: 0 2px 14px rgba(0, 0, 0, 0.32);
  }
  .subline {
    color: rgba(255, 255, 255, 0.86);
    font-size: 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .trust {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-bottom: 1px solid var(--line);
    background: #fbf8f2;
  }
  .trustItem {
    min-height: 58px;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 9px;
    border-right: 1px solid var(--line);
    font-size: 12px;
    font-weight: 700;
    color: #263f39;
  }
  .trustItem:last-child { border-right: 0; }
  .icon {
    flex: 0 0 26px;
    width: 26px;
    height: 26px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    background: #e9f2ee;
    color: var(--accent);
  }
  .content {
    padding: 18px;
    display: grid;
    gap: 14px;
  }
  .notice {
    border: 1px solid rgba(128, 69, 35, 0.16);
    background: var(--danger-soft);
    color: #774a30;
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 700;
  }
  .offer {
    display: grid;
    grid-template-columns: 1.1fr 0.9fr;
    gap: 14px;
  }
  .offerPanel {
    border: 1px solid var(--line);
    border-radius: 14px;
    background: #fff;
    padding: 16px;
    display: grid;
    gap: 12px;
  }
  .label {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0;
  }
  .dates {
    margin: 0;
    font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
    font-size: 30px;
    line-height: 1.08;
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
  }
  .fact {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 9px;
    background: #fbfaf7;
  }
  .priceBox {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .price {
    font-size: 36px;
    line-height: 1;
    font-weight: 850;
    letter-spacing: 0;
  }
  .priceCaption {
    margin-top: 5px;
    color: var(--muted);
    font-size: 13px;
  }
  .actions {
    display: grid;
    gap: 9px;
  }
  button, a.button {
    width: 100%;
    border: 0;
    border-radius: 10px;
    padding: 12px 14px;
    font: inherit;
    font-weight: 800;
    cursor: pointer;
    text-align: center;
    text-decoration: none;
  }
  .primary {
    background: var(--accent);
    color: #fff;
    box-shadow: 0 8px 18px rgba(15, 90, 77, 0.24);
  }
  .secondary {
    background: #f3eee5;
    color: var(--ink);
    border: 1px solid var(--line);
  }
  .acp {
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 13px;
    background: linear-gradient(180deg, #fff, #fbf8f2);
    display: grid;
    gap: 8px;
  }
  .acpTitle {
    font-weight: 850;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .stripe {
    color: #635bff;
    font-weight: 900;
    letter-spacing: 0;
  }
  .acpCopy {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.35;
  }
  .tools {
    border-top: 1px solid var(--line);
    padding: 14px 18px 18px;
    background: #fbf8f2;
  }
  .toolHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }
  .toolCount {
    color: var(--muted);
    font-size: 12px;
    font-weight: 800;
  }
  .toolGrid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }
  .toolChip {
    min-height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: #fff;
    color: #28443d;
    font-size: 11px;
    font-weight: 800;
    text-align: center;
    padding: 6px 8px;
  }
  .empty, .loading {
    padding: 18px;
    color: var(--muted);
    font-size: 13px;
    text-align: center;
  }
  @media (max-width: 620px) {
    body { padding: 8px; }
    .hero { min-height: 214px; }
    h1 { font-size: 28px; }
    .trust { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .trustItem:nth-child(2) { border-right: 0; }
    .offer { grid-template-columns: 1fr; }
    .toolGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .dates { font-size: 26px; }
    .price { font-size: 32px; }
  }
</style>
</head>
<body>
<div id="root" class="loading">Laddar verifierat erbjudande…</div>
<script>
  var VILLA_IMAGE = "https://vfalgymbhyfqsyxkvpqg.supabase.co/storage/v1/object/public/property-images/properties/3ef1d46d-5c23-46fe-86cb-8e714abf734f/other/1777524437024-rewm-2-desktop.jpg?quality=75&resize=cover&width=800";
  var rpcNextId = 1;
  var hostInitialized = false;
  var TOOL_LABELS = [
    "Search", "Availability", "Similar", "Compare",
    "Host price", "Direct URL", "Host domain", "Stripe host",
    "Policy", "Status", "VRP", "Verify node", "Stay offer"
  ];

  function getData() {
    try {
      var w = window;
      if (w.openai && w.openai.toolOutput) return enrichData(w.openai.toolOutput, w.openai.toolResponseMetadata);
      if (w.openai && w.openai.toolResponseMetadata) {
        var meta = w.openai.toolResponseMetadata;
        var full = meta.mcp_tool_result || meta.call_tool_result || meta;
        if (full && full.structuredContent) return enrichData(full.structuredContent, full._meta || meta);
        if (full && full.content) return enrichData(parseContent(full.content), full._meta || meta);
      }
    } catch (e) {}
    try {
      var u = new URL(window.location.href);
      if (u.searchParams.get("demo") === "1") return demoData();
      var raw = u.searchParams.get("data");
      if (raw) return JSON.parse(decodeURIComponent(raw));
    } catch (e) {}
    return null;
  }

  function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function enrichData(data, meta) {
    var base = objectValue(data);
    var sourceMeta = objectValue(meta);
    if (!base || !sourceMeta) return data;
    var enriched = Object.assign({}, base);
    if (!enriched.offer && sourceMeta.offer) enriched.offer = sourceMeta.offer;
    if (!enriched.signed_verified_stay_offer && sourceMeta.signed_verified_stay_offer) {
      enriched.signed_verified_stay_offer = sourceMeta.signed_verified_stay_offer;
    }
    return enriched;
  }

  function parseContent(content) {
    try {
      var item = Array.isArray(content) ? content[0] : null;
      if (item && item.text) return JSON.parse(item.text);
    } catch (e) {}
    return null;
  }

  function demoData() {
    return {
      domain: "villaakerlyckan.se",
      check_in: "2026-10-10",
      check_out: "2026-10-17",
      guests: 6,
      verified: true,
      official_offer_summary: {
        available: true,
        direct_booking_url: "https://www.villaakerlyckan.se/",
        price: { currency: "SEK", agent_total: 11900, exact: true }
      },
      offer: {
        property: {
          name: "Villa Akerlyckan",
          domain: "villaakerlyckan.se",
          city: "Kavlinge",
          region: "Skane",
          country: "Sweden"
        }
      }
    };
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function hostUrl(domain) {
    if (!domain) return "";
    return /^https?:\\/\\//.test(domain) ? domain : "https://" + domain;
  }

  function cleanDomain(value) {
    if (!value) return "";
    try {
      var url = /^https?:\\/\\//.test(value) ? new URL(value) : new URL("https://" + value);
      return url.hostname.replace(/^www\\./, "");
    } catch (e) {
      return String(value).replace(/^https?:\\/\\//, "").replace(/^www\\./, "").split("/")[0];
    }
  }

  function titleFromDomain(domain) {
    var cleaned = cleanDomain(domain);
    if (!cleaned) return "Verified stay";
    return cleaned.split(".")[0].replace(/-/g, " ").replace(/\\b\\w/g, function (m) { return m.toUpperCase(); });
  }

  function nightsBetween(checkIn, checkOut) {
    if (!checkIn || !checkOut) return null;
    var a = Date.parse(checkIn + "T00:00:00Z");
    var b = Date.parse(checkOut + "T00:00:00Z");
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
    return Math.round((b - a) / 86400000);
  }

  function formatDate(value) {
    if (!value) return "";
    try {
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value + "T00:00:00"));
    } catch (e) {
      return value;
    }
  }

  function formatRange(checkIn, checkOut) {
    if (!checkIn && !checkOut) return "Dates to confirm";
    if (!checkOut) return formatDate(checkIn);
    return formatDate(checkIn) + " - " + formatDate(checkOut);
  }

  function pickAmount(values) {
    for (var i = 0; i < values.length; i += 1) {
      var n = Number(values[i]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  function normalizeAmount(n, currency) {
    if (n == null) return null;
    var code = String(currency || "").toUpperCase();
    if ((code === "SEK" || code === "NOK" || code === "DKK" || code === "EUR" || code === "USD") && n >= 200000 && n % 100 === 0) {
      return n / 100;
    }
    return n;
  }

  function money(amount, currency) {
    var normalized = normalizeAmount(amount, currency);
    if (normalized == null) return "Final price pending";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "SEK",
        maximumFractionDigits: 0
      }).format(normalized);
    } catch (e) {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(normalized) + " " + (currency || "");
    }
  }

  function bestListing(data) {
    var pools = [
      asArray(data.properties),
      asArray(data.similarProperties),
      asArray(data.comparison)
    ];
    var unavailable = asArray(data.unavailableMatches);
    for (var i = 0; i < pools.length; i += 1) {
      for (var j = 0; j < pools[i].length; j += 1) {
        if (pools[i][j] && pools[i][j].available !== false) return pools[i][j];
      }
    }
    return unavailable[0] || pools[0][0] || pools[1][0] || pools[2][0] || {};
  }

  function firstImageFrom(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        var img = firstImageFrom(value[i]);
        if (img) return img;
      }
    }
    if (typeof value === "object") {
      return value.url || value.src || value.image || value.href || "";
    }
    return "";
  }

  function collectImagesFrom(value, out) {
    if (!value) return out;
    if (typeof value === "string") {
      if (value && out.indexOf(value) === -1) out.push(value);
      return out;
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) collectImagesFrom(value[i], out);
      return out;
    }
    if (typeof value === "object") {
      collectImagesFrom(value.url || value.src || value.image || value.href || "", out);
    }
    return out;
  }

  function normalizeOffer(data) {
    data = data || {};
    var listing = bestListing(data);
    var offer = data.offer || {};
    var summary = data.official_offer_summary || {};
    var price = summary.price || offer.price || data.price || {};
    var property = summary.property || offer.property || data.property || listing || {};
    var domain = cleanDomain(property.domain || listing.domain || data.propertyDomain || data.domain || offer.canonical_domain || offer.node_id || "");
    var checkIn = data.checkIn || data.check_in || offer.check_in || (offer.request && offer.request.check_in) || listing.checkIn || listing.check_in;
    var checkOut = data.checkOut || data.check_out || offer.check_out || (offer.request && offer.request.check_out) || listing.checkOut || listing.check_out;
    var guests = data.guests || offer.guests || (offer.request && offer.request.guests) || listing.guests;
    var currency = price.currency || data.currency || listing.currency || "SEK";
    var finalAmount = pickAmount([
      price.agent_total,
      price.total,
      data.finalTotal,
      data.totalPrice,
      data.gapTotal,
      data.directBookingTotal,
      data.federationTotal,
      listing.finalTotal,
      listing.totalPrice,
      listing.gapTotal,
      listing.directBookingTotal,
      listing.federationTotal,
      data.publicTotal,
      listing.publicTotal
    ]);
    var available = summary.available;
    if (available === undefined) available = data.available;
    if (available === undefined) available = listing.available;
    if (available === undefined) available = true;
    var directUrl = summary.direct_booking_url ||
      (offer.booking && (offer.booking.direct_booking_url || offer.booking.booking_url)) ||
      data.paymentUrl ||
      data.direct_booking_url ||
      (domain ? hostUrl(domain) : "");
    var images = [
      data.widget_media && data.widget_media.images,
      data.media && data.media.images,
      summary.media && summary.media.images,
      property.image, property.heroImage, property.hero_image, property.image_url,
      property.photos, property.images, property.gallery,
      listing.image, listing.heroImage, listing.hero_image, listing.image_url, listing.photos, listing.images
    ];
    var imageList = [];
    for (var i = 0; i < images.length; i += 1) {
      collectImagesFrom(images[i], imageList);
      var image = firstImageFrom(images[i]);
      if (image) break;
    }
    if (!imageList.length && domain === "villaakerlyckan.se") imageList.push(VILLA_IMAGE);
    var alternatives = asArray(data.alternativeDates);
    if (!alternatives.length) alternatives = asArray(listing.alternativeDates);
    if (!alternatives.length && asArray(data.unavailableMatches).length) {
      alternatives = asArray(data.unavailableMatches[0].alternativeDates);
    }
    return {
      name: property.name || listing.name || data.propertyName || titleFromDomain(domain),
      domain: domain,
      city: property.city || listing.city || "",
      region: property.region || listing.region || "",
      country: property.country || listing.country || "",
      propertyType: property.propertyType || property.type || listing.propertyType || "Vacation rental",
      maxGuests: property.maxGuests || property.max_guests || listing.maxGuests || "",
      checkIn: checkIn,
      checkOut: checkOut,
      guests: guests,
      nights: data.nights || listing.nights || (offer.request && offer.request.nights) || nightsBetween(checkIn, checkOut),
      currency: currency,
      finalAmount: finalAmount,
      available: available !== false,
      directUrl: directUrl,
      logo: property.logo_url || property.logo || listing.logo_url || (summary.property && summary.property.logo_url) || "",
      amenities: asArray(property.amenities).filter(function (a) { return typeof a === "string" && a && a.indexOf("_") === -1; }).slice(0, 4),
      image: imageList[0] || "",
      images: imageList,
      alternatives: alternatives,
      verified: data.verified === true || data.fresh === true || (data.signature && data.signature.verified === true),
      bookable: summary.bookable !== false && available !== false,
      requestedUnavailable: data.available === false || (asArray(data.unavailableMatches).length && !asArray(data.properties).length)
    };
  }

  function sendFollowUp(prompt) {
    try {
      if (window.openai && typeof window.openai.sendFollowUpMessage === "function") {
        window.openai.sendFollowUpMessage({ prompt: prompt, scrollToBottom: true });
        return;
      }
    } catch (e) {}
    window.parent.postMessage({
      jsonrpc: "2.0",
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: prompt }] }
    }, "*");
  }

  function openExternal(href) {
    if (!href) return;
    try {
      if (window.openai && typeof window.openai.openExternal === "function") {
        window.openai.openExternal({ href: href, redirectUrl: false });
        return;
      }
    } catch (e) {}
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function setLoading(message) {
    var root = document.getElementById("root");
    root.className = "loading";
    root.textContent = message || "Laddar verifierat erbjudande…";
  }

  function postToHost(payload) {
    try { window.parent.postMessage(payload, "*"); } catch (e) {}
  }

  function applyToolPayload(params) {
    if (!params) return false;
    var payload = params.structuredContent || parseContent(params.content);
    if (!payload) return false;
    render(enrichData(payload, params._meta));
    return true;
  }

  function sendUiInitialize() {
    var id = rpcNextId++;
    postToHost({
      jsonrpc: "2.0",
      id: id,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        appInfo: { name: "HemmaBo verified stay offer", version: "1.0.0" }
      }
    });
    return id;
  }

  function handleHostMessage(event) {
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;

    if (message.id && message.result && !hostInitialized) {
      hostInitialized = true;
      postToHost({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      var cached = getData();
      if (cached) render(cached);
      return;
    }

    if (message.method === "ui/notifications/tool-result") {
      applyToolPayload(message.params);
      return;
    }

    if (message.method === "ui/notifications/tool-input") {
      var args = (message.params && message.params.arguments) || {};
      if (args.domain && !document.querySelector(".shell")) {
        setLoading("Verifierar " + cleanDomain(args.domain) + "…");
      }
    }
  }

  function bootWidget() {
    var cached = getData();
    if (cached) {
      render(cached);
      return;
    }
    setLoading();
    sendUiInitialize();
  }

  var hbLastData = null;
  function currentDisplayMode() {
    try {
      if (window.openai && window.openai.displayMode) return window.openai.displayMode;
    } catch (e) {}
    return window.__hbDisplayMode || "inline";
  }

  function requestFullscreen() {
    window.__hbDisplayMode = "fullscreen";
    try {
      if (window.openai && typeof window.openai.requestDisplayMode === "function") {
        window.openai.requestDisplayMode({ mode: "fullscreen" });
      }
    } catch (e) {}
    if (hbLastData) render(hbLastData);
  }

  function render(data) {
    var root = document.getElementById("root");
    if (!data) {
      root.className = "loading";
      root.textContent = "Laddar verifierat erbjudande…";
      return;
    }
    hbLastData = data;
    var offer = normalizeOffer(data);
    var location = [offer.city, offer.region, offer.country].filter(Boolean).join(", ");
    var facts = [
      offer.nights ? offer.nights + " nights" : "",
      offer.guests ? offer.guests + " guests" : "",
      offer.maxGuests ? "up to " + offer.maxGuests + " guests" : "",
      offer.propertyType
    ].filter(Boolean);
    var notice = "";
    if (!offer.available || offer.requestedUnavailable) {
      notice = '<div class="notice">Requested dates are not available at the host source.';
      if (offer.alternatives.length) notice += " An alternative date window is ready below.";
      notice += "</div>";
      if (offer.alternatives.length) {
        var alt = offer.alternatives[0];
        offer.checkIn = alt.checkIn || alt.check_in || offer.checkIn;
        offer.checkOut = alt.checkOut || alt.check_out || offer.checkOut;
        offer.nights = alt.nights || nightsBetween(offer.checkIn, offer.checkOut);
        offer.finalAmount = pickAmount([alt.finalTotal, alt.totalPrice, alt.gapTotal, alt.directBookingTotal, alt.federationTotal, alt.publicTotal, offer.finalAmount]);
        offer.currency = alt.currency || offer.currency;
      }
    }
    var heroList = asArray(offer.images).length ? asArray(offer.images) : (offer.image ? [offer.image] : []);
    root.className = "cert";
    var initials = (offer.name || "").split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join("") || "VR";
    var logoMark = offer.logo
      ? '<img src="' + esc(offer.logo) + '" alt="" referrerpolicy="no-referrer" style="width:34px;height:34px;border-radius:50%;object-fit:cover;background:#fff;border:1px solid #E0D6C2;">'
      : '<div style="width:34px;height:34px;border-radius:50%;background:#fff;color:#211E17;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;font-size:14px;">' + esc(initials) + '</div>';
    var heroArea = heroList.length
      ? '<img id="heroMain" src="' + esc(heroList[0]) + '" alt="' + esc(offer.name) + '" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover;display:block;">'
      : '<div style="width:100%;height:100%;background:linear-gradient(135deg,#c2cdbb,#8aa0a8 55%,#3d5a52);"></div>';
    var counter = heroList.length > 1 ? '<div style="position:absolute;bottom:8px;right:10px;font-size:10px;color:#fff;background:rgba(33,30,23,.5);padding:3px 9px;border-radius:20px;">1 / ' + heroList.length + ' · browse</div>' : '';
    var thumbs = heroList.length > 1
      ? '<div style="display:flex;gap:5px;padding:5px 8px;background:#EFE9DC;">' + heroList.slice(0, 4).map(function (src) { return '<img class="thumb" src="' + esc(src) + '" alt="" aria-hidden="true" referrerpolicy="no-referrer" style="height:34px;flex:1;min-width:0;border-radius:6px;object-fit:cover;cursor:pointer;">'; }).join("") + '</div>'
      : '';
    var amen = asArray(offer.amenities).length
      ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:11px;">' + asArray(offer.amenities).map(function (a) { return '<span class="vchip">' + esc(a) + '</span>'; }).join("") + '</div>'
      : '';
    var subline = [location || cleanDomain(offer.domain), formatRange(offer.checkIn, offer.checkOut), (offer.guests ? offer.guests + " guests" : "")].filter(Boolean).join(" · ");
    var bookDomain = cleanDomain(offer.domain) || "host domain";
    var verifyUrl = "https://vacationrentalprotocol.com/verify?domain=" + encodeURIComponent(cleanDomain(offer.domain) || "");
    var bookUrl = offer.directUrl || hostUrl(offer.domain);
    var isFull = currentDisplayMode() === "fullscreen";
    var styleBlock = '<style>.hbcoin{width:46px;height:46px;perspective:320px}.hbcoin-in{position:relative;width:100%;height:100%;transform-style:preserve-3d;animation:hbspin 5.5s linear infinite}.hbf,.hbb{position:absolute;inset:0;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;-webkit-backface-visibility:hidden;backface-visibility:hidden;background:#E9D9A6;border:2px solid #B8932F;color:#6E5618}.hbb{transform:rotateY(180deg)}.hbf svg{width:22px;height:22px}@keyframes hbspin{to{transform:rotateY(360deg)}}@media(prefers-reduced-motion:reduce){.hbcoin-in{animation:none}}.vchip{font-size:11px;padding:4px 10px;border:1px solid #DFD3BC;border-radius:20px;color:#5C5443;background:#FBF8F1;white-space:nowrap}.hbcoin-sm{width:30px;height:30px}.hbcoin-sm .hbf svg{width:15px;height:15px}.hbcoin-sm .hbb span:first-child{font-size:6px}.hbcoin-sm .hbb span:last-child{display:none}</style>';
    var sealHtml = '<div id="verifySeal" class="hbcoin" title="Verify this offer" aria-label="Verify this offer" role="button" tabindex="0" style="cursor:pointer;"><div class="hbcoin-in"><div class="hbf"><svg viewBox="0 0 24 24" fill="none" stroke="#6E5618" stroke-width="1.4" stroke-linecap="round"><path d="M5 11a7 7 0 0 1 14 0"/><path d="M7.5 12a4.5 4.5 0 0 1 9 0v2.5"/><path d="M10 12.5a2 2 0 0 1 4 0v4"/><path d="M12 15v3.5"/></svg></div><div class="hbb"><span style="font-size:8px;letter-spacing:.5px;font-weight:bold;">Ed25519</span><span style="font-size:7px;letter-spacing:1px;">VRP</span></div></div></div>';
    var sealSm = sealHtml.replace('class="hbcoin"', 'class="hbcoin hbcoin-sm"');
    var prideHtml = '<div style="font-size:12px;color:#3B6B57;margin-top:7px;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3B6B57" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>Signed by <strong style="font-weight:500;">' + esc(bookDomain) + '</strong> · verified on its own domain</div>';
    var chipsHtml = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;"><span class="vchip">0% commission</span><span class="vchip">Payment direct to host</span><span class="vchip">AI-agent bookable</span></div>';
    var bookHtml = '<a id="bookLink" href="' + esc(bookUrl) + '" target="_blank" rel="noopener" aria-label="Open direct booking URL" style="display:block;background:#2C5A47;color:#F4EFE4;border-radius:9px;padding:12px;text-align:center;font-size:13px;font-weight:500;text-decoration:none;">Book direct on ' + esc(bookDomain) + ' →</a>';
    if (isFull) {
      root.innerHTML = styleBlock +
        '<div style="background:#F4EFE4;border:1px solid #E0D6C2;border-radius:16px;overflow:hidden;color:#211E17;font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:460px;margin:0 auto;">' +
          notice +
          '<div style="position:relative;height:210px;background:#dfe3da;">' + heroArea +
            '<div style="position:absolute;top:10px;left:10px;">' + logoMark + '</div>' +
            '<div style="position:absolute;top:10px;right:10px;">' + sealHtml + '</div>' +
            '<div aria-label="Verified stay offer" style="position:absolute;bottom:8px;left:12px;font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#fff;background:rgba(33,30,23,.55);padding:3px 8px;border-radius:20px;">Verified stay offer</div>' + counter +
          '</div>' + thumbs +
          '<div style="padding:14px 18px 16px;">' +
            '<div style="font-family:Georgia,serif;font-size:23px;line-height:1.1;">' + esc(offer.name) + '</div>' +
            '<div style="font-size:12px;color:#8C8270;margin-top:3px;">' + esc(subline) + '</div>' +
            prideHtml + amen +
            '<div style="height:1px;background:#BFA15A;opacity:.45;margin:13px 0;"></div>' +
            '<div style="display:flex;align-items:baseline;gap:8px;"><div style="font-family:Georgia,serif;font-size:26px;">' + esc(money(offer.finalAmount, offer.currency)) + '</div><div style="font-size:12px;color:#8C8270;">total · direct from host</div></div>' +
            chipsHtml +
            '<div style="margin-top:14px;">' + bookHtml + '</div>' +
            '<div style="font-size:10px;color:#9A8E76;text-align:center;margin-top:9px;">Offer verified moments ago · price exact · no add-on fees</div>' +
          '</div>' +
        '</div>';
    } else {
      root.innerHTML = styleBlock +
        '<div style="background:#F4EFE4;border:1px solid #E0D6C2;border-radius:12px;padding:10px 13px;color:#211E17;font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:404px;margin:0 auto;">' +
          notice +
          '<div style="display:flex;align-items:center;gap:9px;">' + logoMark +
            '<div style="min-width:0;flex:1;">' +
              '<div aria-label="Verified stay offer" title="Verified stay offer" style="font-family:Georgia,serif;font-size:16px;line-height:1.1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(offer.name) + '</div>' +
              '<div style="font-size:10px;color:#8C8270;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(subline) + '</div>' +
            '</div>' + sealSm +
          '</div>' +
          '<div style="display:flex;align-items:baseline;gap:6px;margin-top:8px;"><div style="font-family:Georgia,serif;font-size:19px;">' + esc(money(offer.finalAmount, offer.currency)) + '</div><div style="font-size:10px;color:#8C8270;">total · direct from host · 0% commission</div></div>' +
          '<div style="margin-top:9px;">' + bookHtml + '</div>' +
          '<button id="expandBtn" style="display:block;width:100%;margin-top:6px;background:none;border:none;color:#3B6B57;font-size:11px;cursor:pointer;text-align:center;">See photos &amp; details →</button>' +
        '</div>';
    }
    var bookLink = document.getElementById("bookLink");
    if (bookLink) {
      bookLink.addEventListener("click", function (e) {
        e.preventDefault();
        openExternal(bookUrl);
      });
    }
    var verifySeal = document.getElementById("verifySeal");
    if (verifySeal) {
      verifySeal.addEventListener("click", function () { openExternal(verifyUrl); });
    }
    var expandBtn = document.getElementById("expandBtn");
    if (expandBtn) {
      expandBtn.addEventListener("click", function () { requestFullscreen(); });
    }
    var heroMain = document.getElementById("heroMain");
    if (heroMain) {
      heroMain.addEventListener("error", function () { heroMain.style.display = "none"; }, { once: true });
    }
    root.querySelectorAll(".thumb").forEach(function (t) {
      t.addEventListener("click", function () { if (heroMain) heroMain.src = t.src; });
      t.addEventListener("error", function () { t.style.display = "none"; }, { once: true });
    });
  }

  window.addEventListener("message", handleHostMessage, { passive: true });

  window.addEventListener("openai:set_globals", function (event) {
    var globals = event && event.detail && event.detail.globals;
    if (!globals) return;
    if (globals.displayMode) {
      window.__hbDisplayMode = globals.displayMode;
      if (!globals.toolOutput && !globals.toolResponseMetadata && hbLastData) {
        render(hbLastData);
        return;
      }
    }
    if (globals.toolOutput) {
      render(enrichData(globals.toolOutput, globals.toolResponseMetadata));
      return;
    }
    if (globals.toolResponseMetadata) {
      var meta = globals.toolResponseMetadata;
      var full = meta.mcp_tool_result || meta.call_tool_result || meta;
      render(full && enrichData(full.structuredContent || parseContent(full.content), full._meta || meta));
    }
  }, { passive: true });

  bootWidget();
</script>
</body>
</html>`;
