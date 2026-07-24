export const VERIFIED_STAY_OFFER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>HemmaBo verified stay offer</title>
<style>
  :root {
    color-scheme: dark;
    --stage: #060D18;
    --navy: #0B1626;
    --navy-2: #101B30;
    --navy-3: #1A2A44;
    --hairline: #2A3A52;
    --gold: #C9A84C;
    --gold-soft: #C9B98A;
    --gold-deep: #8A6D1F;
    --paper: #F5EFE2;
    --paper-ink: #0B1626;
    --paper-warm: #4A4436;
    --paper-mute: #8A7B5A;
    --ivory: #F5EFE2;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 6px;
    background: transparent;
    color: var(--ivory);
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  #root.loading {
    min-height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: var(--gold-soft);
    background: var(--stage);
    border-radius: 14px;
  }
  .stage {
    position: relative;
    width: min(100%, 720px);
    margin: 0 auto;
    background: var(--stage);
    border-radius: 14px;
    padding: 20px 24px 16px;
    overflow: hidden;
  }
  .streak {
    position: absolute;
    left: -8%;
    right: -8%;
    top: 46%;
    height: 2px;
    background: linear-gradient(90deg, rgba(201,168,76,0) 0%, rgba(201,168,76,0.35) 35%, rgba(232,217,168,0.75) 50%, rgba(201,168,76,0.35) 65%, rgba(201,168,76,0) 100%);
    pointer-events: none;
  }
  .letter {
    position: relative;
    display: flex;
    min-height: 188px;
    border: 1px solid var(--gold);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    overflow: hidden;
  }
  .photo {
    position: relative;
    width: 41%;
    min-width: 190px;
    background: var(--navy-3);
    cursor: pointer;
  }
  .photo img { width: 100%; height: 100%; object-fit: cover; display: block; transition: opacity 0.45s ease; }
  .paper {
    flex: 1;
    min-width: 0;
    background: var(--paper);
    color: var(--paper-ink);
    padding: 15px 18px 12px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 6px;
  }
  .lname {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 21px;
    line-height: 1.1;
    color: var(--paper-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lloc {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 10px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--paper-mute);
    margin-top: 3px;
  }
  .lmatch {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 13px;
    line-height: 1.45;
    color: var(--paper-warm);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ldates {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 10.5px;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--paper-ink);
  }
  .lrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .price {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 16px;
    color: var(--gold-deep);
    white-space: nowrap;
  }
  .cta {
    display: inline-block;
    background: linear-gradient(180deg, #E3C46A 0%, #C9A84C 55%, #B8932F 100%);
    color: var(--navy);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 9px 14px;
    border-radius: 4px;
    text-decoration: none;
    white-space: nowrap;
  }
  .cta:hover { filter: brightness(1.06); }
  .notice {
    background: var(--paper);
    color: #7A4A22;
    border: 1px solid var(--gold);
    border-bottom: none;
    font-size: 12px;
    padding: 8px 14px;
    border-radius: 8px 8px 0 0;
  }
  .notice + .letter { border-radius: 0; }
  .unfold {
    max-height: 0;
    overflow: hidden;
    -webkit-overflow-scrolling: touch;
    transition: max-height 0.55s ease;
    border-left: 1px solid var(--gold);
    border-right: 1px solid var(--gold);
    background: #0C1830;
  }
  .unfold.open { overflow-y: auto; }
  .unfold-in { padding: 13px 16px; display: flex; flex-direction: column; gap: 10px; }
  .gal { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; }
  .gthumb {
    height: 58px;
    border-radius: 5px;
    object-fit: cover;
    width: 100%;
    cursor: pointer;
    background: var(--navy-3);
  }
  .chips2 { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--gold-soft); }
  .fact2 { font-size: 11.5px; color: #7C8CA3; }
  /* W5c villkorssymmetrin: cancellation line on the card + the three quiet
     groups (What's included / Good to know / Terms) in the unfolded view. */
  .lcancel { font-size: 11.5px; color: #9AA8BC; margin-top: 2px; }
  .grp { border-top: 1px solid rgba(244,181,63,0.18); padding-top: 8px; }
  .grph { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: #8FA0B8; margin-bottom: 3px; font-weight: 600; }
  .grpb { font-size: 12.5px; color: var(--gold-soft); line-height: 1.55; }
  .lpitch {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--gold-soft);
  }
  .lip {
    position: relative;
    height: 46px;
    background: var(--navy-2);
    border: 1px solid var(--hairline);
    border-radius: 0 0 8px 8px;
    overflow: hidden;
  }
  .fold-l, .fold-r {
    position: absolute;
    top: 0;
    width: 50%;
    height: 100%;
    pointer-events: none;
  }
  .fold-l { left: 0; border-right: 1px solid #223050; transform: skewX(38deg); transform-origin: top left; }
  .fold-r { right: 0; border-left: 1px solid #223050; transform: skewX(-38deg); transform-origin: top right; }
  .lipbtn {
    position: absolute;
    inset: 0;
    width: 100%;
    background: transparent;
    border: none;
    color: var(--gold-soft);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 10.5px;
    letter-spacing: 2px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .hbcoin {
    display: block;
    position: absolute;
    right: 26px;
    bottom: 20px;
    width: 52px;
    height: 52px;
    perspective: 340px;
    cursor: pointer;
    z-index: 3;
  }
  .hbcoin-in {
    position: relative;
    width: 100%;
    height: 100%;
    transform-style: preserve-3d;
    animation: hbspin 5.5s linear infinite;
  }
  .hbf, .hbb {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
    background: radial-gradient(circle at 32% 30%, #F4E7B4 0%, #E3C46A 34%, #C9A84C 62%, #9A7B24 100%);
    border: 2px solid #E8D9A8;
    color: #5C4A12;
    box-shadow: 0 3px 10px rgba(0,0,0,0.45);
  }
  .hbf::after, .hbb::after {
    content: "";
    position: absolute;
    inset: 5px;
    border-radius: 50%;
    border: 1px solid rgba(138,109,31,0.55);
    pointer-events: none;
  }
  .hbb { transform: rotateY(180deg); }
  .hbf span {
    font-family: Georgia, serif;
    font-size: 15px;
    letter-spacing: 1px;
  }
  .hbb span {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 8px;
    letter-spacing: 0.5px;
  }
  @keyframes hbspin { to { transform: rotateY(360deg); } }
  @media (prefers-reduced-motion: reduce) { .hbcoin-in { animation: none; } }
  .full-hero { position: relative; height: 230px; border-radius: 8px 8px 0 0; overflow: hidden; border: 1px solid var(--gold); border-bottom: none; background: var(--navy-3); }
  .full-hero img { width: 100%; height: 100%; object-fit: cover; display: block; transition: opacity 0.45s ease; }
  @media (max-width: 560px) {
    .stage { padding: 14px 14px 12px; }
    .letter { flex-direction: column; min-height: 0; }
    .photo { width: 100%; min-width: 0; height: 150px; }
    .lname { white-space: normal; }
    .hbcoin { right: 16px; bottom: 16px; width: 46px; height: 46px; }
  }
</style>
</head>
<body>
<div id="root" class="loading">Loading the offer…</div>
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
    }
    imageList = imageList.slice(0, 8);
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
      amenities: asArray(property.amenities).filter(function (a) { return typeof a === "string" && !!a; }).map(function (a) { return String(a).indexOf("_") === -1 ? a : a.split("_").join(" ").replace(/^./, function (c) { return c.toUpperCase(); }); }).slice(0, 4),
      image: imageList[0] || "",
      images: imageList,
      alternatives: alternatives,
      // W5c villkorssymmetrin: the host's starred "Det lilla extra", the
      // SIGNED terms + minimum age (class verifiable, from the offer JWS via
      // the summary), the verbatim refund ladder, and stay times. All
      // absence-safe: older nodes without these fields render exactly as
      // before (unknown is never invented into a yes or a no).
      starred: asArray(property.starred_amenities).filter(function (a) { return typeof a === "string" && !!a; }).slice(0, 8),
      terms: (summary.terms && typeof summary.terms === "object") ? summary.terms : null,
      minAge: (typeof summary.minimum_guest_age === "number" && summary.minimum_guest_age > 0) ? Math.floor(summary.minimum_guest_age) : null,
      refund: Array.isArray(summary.refund_schedule) ? summary.refund_schedule : null,
      checkInTime: (summary.stay_details && typeof summary.stay_details.check_in_time === "string") ? summary.stay_details.check_in_time : "",
      checkOutTime: (summary.stay_details && typeof summary.stay_details.check_out_time === "string") ? summary.stay_details.check_out_time : "",
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

  function tryHostOpen(href) {
    if (!href) return false;
    try {
      if (window.openai && typeof window.openai.openExternal === "function") {
        window.openai.openExternal({ href: href, redirectUrl: false });
        return true;
      }
    } catch (e) {}
    return false;
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

  // CEO-LOCKED guest source-boundary copy — mirror of lib/vrp-trust-copy.ts
  // (SoT: hemmabo-smart-stays docs/CANONICAL_TRUST_LAYER_COPY.md \u00a74b).
  // Rendered verbatim in the guest's language; en is the explicit fallback.
  var GUEST_COPY = {
    sv: "V\u00e4lkommen till {nameGenitive} egen officiella bokningssida. H\u00e4r bokar du direkt hos v\u00e4rden \u2013 utan mellanh\u00e4nder. Priset du ser kommer direkt fr\u00e5n v\u00e4rden och betalningen g\u00e5r direkt till v\u00e4rden. All information p\u00e5 denna sida kan verifieras \u2013 \u00e4ven av AI-assistenter.",
    en: "Welcome to {nameGenitive} own official booking page. Here you book directly with the host \u2013 no middlemen. The price you see comes directly from the host and your payment goes directly to the host. Everything on this page can be verified \u2013 including by AI assistants.",
    de: "Willkommen auf der eigenen offiziellen Buchungsseite von {name}. Hier buchen Sie direkt beim Gastgeber \u2013 ohne Zwischenh\u00e4ndler. Der Preis, den Sie sehen, kommt direkt vom Gastgeber und Ihre Zahlung geht direkt an den Gastgeber. Alles auf dieser Seite kann \u00fcberpr\u00fcft werden \u2013 auch von KI-Assistenten.",
    fr: "Bienvenue sur la page de r\u00e9servation officielle de {name}. Ici, vous r\u00e9servez directement aupr\u00e8s de l'h\u00f4te \u2013 sans interm\u00e9diaires. Le prix affich\u00e9 vient directement de l'h\u00f4te et votre paiement va directement \u00e0 l'h\u00f4te. Tout sur cette page peut \u00eatre v\u00e9rifi\u00e9 \u2013 y compris par des assistants IA.",
    da: "Velkommen til {nameGenitive} egen officielle bookingside. Her booker du direkte hos v\u00e6rten \u2013 uden mellemled. Prisen, du ser, kommer direkte fra v\u00e6rten, og din betaling g\u00e5r direkte til v\u00e6rten. Alt p\u00e5 denne side kan verificeres \u2013 ogs\u00e5 af AI-assistenter.",
    no: "Velkommen til {nameGenitive} egen offisielle bookingside. Her booker du direkte hos verten \u2013 uten mellomledd. Prisen du ser, kommer direkte fra verten, og betalingen g\u00e5r direkte til verten. Alt p\u00e5 denne siden kan verifiseres \u2013 ogs\u00e5 av AI-assistenter.",
    fi: "Tervetuloa kohteen {name} omalle viralliselle varaussivulle. T\u00e4\u00e4ll\u00e4 varaat suoraan is\u00e4nn\u00e4lt\u00e4 \u2013 ilman v\u00e4lik\u00e4si\u00e4. N\u00e4kem\u00e4si hinta tulee suoraan is\u00e4nn\u00e4lt\u00e4 ja maksusi menee suoraan is\u00e4nn\u00e4lle. Kaikki t\u00e4ll\u00e4 sivulla voidaan todentaa \u2013 my\u00f6s teko\u00e4lyavustajien toimesta.",
    nl: "Welkom op de eigen offici\u00eble boekingspagina van {name}. Hier boek je rechtstreeks bij de gastheer \u2013 zonder tussenpersonen. De prijs die je ziet komt rechtstreeks van de gastheer en je betaling gaat rechtstreeks naar de gastheer. Alles op deze pagina kan worden geverifieerd \u2013 ook door AI-assistenten.",
    es: "Bienvenido a la p\u00e1gina de reservas oficial de {name}. Aqu\u00ed reservas directamente con el anfitri\u00f3n \u2013 sin intermediarios. El precio que ves viene directamente del anfitri\u00f3n y tu pago va directamente al anfitri\u00f3n. Todo en esta p\u00e1gina puede verificarse \u2013 tambi\u00e9n por asistentes de IA.",
    it: "Benvenuto nella pagina di prenotazione ufficiale di {name}. Qui prenoti direttamente con l'host \u2013 senza intermediari. Il prezzo che vedi arriva direttamente dall'host e il tuo pagamento va direttamente all'host. Tutto su questa pagina pu\u00f2 essere verificato \u2013 anche dagli assistenti IA.",
    pl: "Witamy na oficjalnej stronie rezerwacji obiektu {name}. Tutaj rezerwujesz bezpo\u015brednio u gospodarza \u2013 bez po\u015bredni\u00f3w. Cena, kt\u00f3r\u0105 widzisz, pochodzi bezpo\u015brednio od gospodarza, a p\u0142atno\u015b\u0107 trafia bezpo\u015brednio do gospodarza. Wszystko na tej stronie mo\u017cna zweryfikowa\u0107 \u2013 tak\u017ce przez asystent\u00f3w AI.",
    ar: "\u0645\u0631\u062d\u0628\u064b\u0627 \u0628\u0643 \u0641\u064a \u0635\u0641\u062d\u0629 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0631\u0633\u0645\u064a\u0629 \u0627\u0644\u062e\u0627\u0635\u0629 \u0628\u0640{name}. \u0647\u0646\u0627 \u062a\u062d\u062c\u0632 \u0645\u0628\u0627\u0634\u0631\u0629 \u0644\u062f\u0649 \u0627\u0644\u0645\u0636\u064a\u0641 \u2013 \u062f\u0648\u0646 \u0648\u0633\u0637\u0627\u0621. \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0630\u064a \u062a\u0631\u0627\u0647 \u064a\u0623\u062a\u064a \u0645\u0628\u0627\u0634\u0631\u0629 \u0645\u0646 \u0627\u0644\u0645\u0636\u064a\u0641\u060c \u0648\u062f\u0641\u0639\u062a\u0643 \u062a\u0630\u0647\u0628 \u0645\u0628\u0627\u0634\u0631\u0629 \u0625\u0644\u0649 \u0627\u0644\u0645\u0636\u064a\u0641. \u0643\u0644 \u0645\u0627 \u0641\u064a \u0647\u0630\u0647 \u0627\u0644\u0635\u0641\u062d\u0629 \u0642\u0627\u0628\u0644 \u0644\u0644\u062a\u062d\u0642\u0642 \u2013 \u062d\u062a\u0649 \u0645\u0646 \u0642\u0650\u0628\u0644 \u0645\u0633\u0627\u0639\u062f\u064a \u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0627\u0635\u0637\u0646\u0627\u0639\u064a.",
  };

  function svGen(name) {
    var trimmed = String(name || "").trim();
    return /[sxz]$/i.test(trimmed) ? trimmed : trimmed + "s";
  }

  function enGen(name) {
    var trimmed = String(name || "").trim();
    return /s$/i.test(trimmed) ? trimmed + "'" : trimmed + "'s";
  }

  function guestCopyLocale() {
    var lang = "";
    try { lang = (navigator.language || "").toLowerCase().split("-")[0]; } catch (e) {}
    return GUEST_COPY[lang] ? lang : "en";
  }

  function guestWelcome(name) {
    var trimmed = String(name || "").trim();
    if (!trimmed) return "";
    var loc = guestCopyLocale();
    var interp = trimmed;
    if (loc === "sv" || loc === "da" || loc === "no") interp = svGen(trimmed);
    else if (loc === "en") interp = enGen(trimmed);
    return GUEST_COPY[loc].replace("{nameGenitive}", interp).replace("{name}", interp);
  }

  function widgetStrings() {
    var sv = false;
    try {
      var lang = (navigator.language || "").toLowerCase();
      sv = lang.indexOf("sv") === 0;
    } catch (e) {}
    return sv ? {
      cta: "Fortsätt till värdens sida →",
      more: "Se mer om boendet ▾",
      less: "Visa mindre ▴",
      night: "natt",
      nights: "nätter",
      guests: "gäster",
      upTo: "upp till",
      unavailable: "Datumen är inte lediga hos värden.",
      altReady: "Ett alternativt datumfönster visas nedan.",
      datesTbc: "Datum bekräftas",
      // W5c villkorssymmetrin — wording mirrors smart-stays
      // contracts/ts/booking-terms-email.ts (sv), pinned by contract test.
      goodToKnow: "Bra att veta",
      included: "Det här ingår",
      termsHead: "Villkor",
      minAge: "Minsta ålder",
      checkin: "Incheckning",
      checkout: "Utcheckning",
      noWord: "nej",
      cancelFree: "Avboka fritt till {h} h före incheckning",
      cancelRow: "{p} % återbetalning senast {h} h före incheckning"
    } : {
      cta: "Continue on the host's site →",
      more: "More about the stay ▾",
      less: "Show less ▴",
      night: "night",
      nights: "nights",
      guests: "guests",
      upTo: "up to",
      unavailable: "These dates aren't available at the host.",
      altReady: "An alternative date window is shown below.",
      datesTbc: "Dates to confirm",
      goodToKnow: "Good to know",
      included: "What's included",
      termsHead: "Terms",
      minAge: "Minimum age",
      checkin: "Check-in",
      checkout: "Check-out",
      noWord: "no",
      cancelFree: "Free cancellation until {h}h before check-in",
      cancelRow: "{p}% refund at least {h}h before check-in"
    };
  }

  // W5c villkorssymmetrin: fixed sv/en vocabulary for the term claim keys —
  // byte-identical to smart-stays contracts/ts/booking-terms-email.ts for
  // the shared keys (one source by test, not by import). Keys outside the
  // map fall back to the same humanizer the amenity row uses — a machine
  // key never renders raw.
  var TERM_LABELS = {
    linens_included: { sv: "Sängkläder ingår", en: "Bed linens included" },
    towels_included: { sv: "Handdukar ingår", en: "Towels included" },
    breakfast_included: { sv: "Frukost ingår", en: "Breakfast included" },
    final_cleaning_included: { sv: "Slutstädning", en: "Final cleaning" },
    wifi: { sv: "WiFi", en: "WiFi" },
    welcome_package: { sv: "Välkomstpaket", en: "Welcome package" },
    pets_dogs: { sv: "Hundar", en: "Dogs" },
    pets_cats: { sv: "Katter", en: "Cats" },
    smoking_indoor: { sv: "Rökning inomhus", en: "Indoor smoking" },
    smoking_outdoor: { sv: "Rökning utomhus", en: "Outdoor smoking" }
  };

  function humanizeKey(key) {
    var s = String(key || "");
    return s.indexOf("_") === -1 ? s : s.split("_").join(" ").replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function termLabel(key, sv) {
    var entry = TERM_LABELS[key];
    if (entry) return sv ? entry.sv : entry.en;
    return humanizeKey(key);
  }

  function isSvUi() {
    try { return (navigator.language || "").toLowerCase().indexOf("sv") === 0; } catch (e) { return false; }
  }

  /** One quiet cancellation line for the card, from the top refund row
   *  (rows are the signed ladder, relayed verbatim — hours/percent form,
   *  never re-labelled into named tiers). Empty/absent ⇒ "". */
  function cancelLine(refund, T) {
    if (!refund || !refund.length) return "";
    var top = refund[0];
    for (var i = 1; i < refund.length; i += 1) {
      if (refund[i] && refund[i].hours_before_checkin > top.hours_before_checkin) top = refund[i];
    }
    if (!top || typeof top.hours_before_checkin !== "number" || typeof top.refund_percent !== "number") return "";
    if (top.refund_percent === 100) return T.cancelFree.replace("{h}", String(top.hours_before_checkin));
    return T.cancelRow.replace("{p}", String(top.refund_percent)).replace("{h}", String(top.hours_before_checkin));
  }

  /** The three quiet unfolded groups: What's included / Good to know /
   *  Terms. Built from the SIGNED terms + refund ladder + stay times.
   *  Returns "" when the node publishes no terms (older nodes) — the
   *  caller then keeps the legacy amenity chips instead. */
  function termGroupsHtml(offer, T) {
    if (!offer.terms) return "";
    var sv = isSvUi();
    var terms = offer.terms;
    var included = asArray(terms.service_included).map(function (k) { return termLabel(k, sv); });
    var good = [];
    asArray(terms.service_not_included).forEach(function (k) { good.push(termLabel(k, sv) + ": " + T.noWord); });
    var negated = (terms.policy_claims && asArray(terms.policy_claims.negated)) || [];
    negated.forEach(function (k) { good.push(termLabel(k, sv) + ": " + T.noWord); });
    if (offer.minAge) good.push(T.minAge + ": " + offer.minAge + "+");
    var termBits = [];
    asArray(offer.refund).forEach(function (row) {
      if (row && typeof row.hours_before_checkin === "number" && typeof row.refund_percent === "number") {
        termBits.push(T.cancelRow.replace("{p}", String(row.refund_percent)).replace("{h}", String(row.hours_before_checkin)));
      }
    });
    if (offer.checkInTime) termBits.push(T.checkin + " " + offer.checkInTime);
    if (offer.checkOutTime) termBits.push(T.checkout + " " + offer.checkOutTime);
    var html = "";
    if (included.length) html += '<div class="grp"><div class="grph">' + esc(T.included) + '</div><div class="grpb">' + esc(included.join(" · ")) + '</div></div>';
    if (good.length) html += '<div class="grp"><div class="grph">' + esc(T.goodToKnow) + '</div><div class="grpb">' + esc(good.join(" · ")) + '</div></div>';
    if (termBits.length) html += '<div class="grp"><div class="grph">' + esc(T.termsHead) + '</div><div class="grpb">' + esc(termBits.join(" · ")) + '</div></div>';
    return html;
  }

  var hbUnfolded = false;
  var hbCarouselTimer = null;
  var hbCarouselIdx = 0;

  function startCarousel(heroMain, list) {
    if (hbCarouselTimer) { clearInterval(hbCarouselTimer); hbCarouselTimer = null; }
    if (!heroMain || !list || list.length < 2) return;
    try {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch (e) {}
    hbCarouselTimer = setInterval(function () {
      if (!heroMain.isConnected) { clearInterval(hbCarouselTimer); hbCarouselTimer = null; return; }
      hbCarouselIdx = (hbCarouselIdx + 1) % list.length;
      var next = list[hbCarouselIdx];
      heroMain.style.opacity = "0";
      setTimeout(function () {
        heroMain.style.display = "";
        heroMain.src = next;
        heroMain.style.opacity = "1";
      }, 240);
    }, 5000);
  }

  function render(data) {
    var root = document.getElementById("root");
    if (!data) {
      root.className = "loading";
      root.textContent = "Loading the offer…";
      return;
    }
    hbLastData = data;
    var T = widgetStrings();
    var offer = normalizeOffer(data);
    var location = [offer.city, offer.region].filter(Boolean).join(" · ") || cleanDomain(offer.domain);
    var notice = "";
    if (!offer.available || offer.requestedUnavailable) {
      notice = '<div class="notice">' + T.unavailable;
      if (offer.alternatives.length) notice += " " + T.altReady;
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
    // W5c: the compact card carries the HOST'S starred "Det lilla extra"
    // when curated (max 8); the generic amenity row stays as fallback.
    var matchLine = asArray(offer.starred).length
      ? asArray(offer.starred).join(" · ")
      : asArray(offer.amenities).join(" · ");
    var cancelHtml = "";
    var cancelText = cancelLine(offer.refund, T);
    if (cancelText) cancelHtml = '<div class="lcancel">' + esc(cancelText) + '</div>';
    var dateBits = [];
    if (offer.checkIn || offer.checkOut) dateBits.push(formatRange(offer.checkIn, offer.checkOut));
    else dateBits.push(T.datesTbc);
    if (offer.nights) dateBits.push(offer.nights + " " + (offer.nights === 1 ? T.night : T.nights));
    if (offer.guests) dateBits.push(offer.guests + " " + T.guests);
    else if (offer.maxGuests) dateBits.push(T.upTo + " " + offer.maxGuests + " " + T.guests);
    var dateLine = dateBits.join(" · ");
    var bookUrl = offer.directUrl || hostUrl(offer.domain);
    var verifyUrl = "https://vacationrentalprotocol.com/verify?domain=" + encodeURIComponent(cleanDomain(offer.domain) || "");
    var isFull = currentDisplayMode() === "fullscreen";

    var photoHtml = heroList.length
      ? '<img id="heroMain" src="' + esc(heroList[0]) + '" alt="' + esc(offer.name) + '" referrerpolicy="no-referrer">'
      : "";
    var galHtml = "";
    if (heroList.length > 1) {
      galHtml = '<div class="gal">' + heroList.slice(1, 5).map(function (src) {
        return '<img class="gthumb" src="' + esc(src) + '" alt="" aria-hidden="true" referrerpolicy="no-referrer">';
      }).join("") + '</div>';
    }
    // W5c: when the node publishes SIGNED terms, the unfolded view shows the
    // three quiet groups (What's included / Good to know / Terms) and the
    // legacy amenity chips are dropped — the compact card already carries
    // the highlights, so repeating them wasted the surface. Older nodes
    // without terms keep the chips exactly as before.
    var groupsHtml = termGroupsHtml(offer, T);
    var chipsHtml = groupsHtml
      ? groupsHtml
      : (asArray(offer.amenities).length
        ? '<div class="chips2">' + asArray(offer.amenities).map(function (a) { return '<span>' + esc(a) + '</span>'; }).join("") + '</div>'
        : "");
    var factBits = [];
    if (offer.maxGuests) factBits.push(T.upTo + " " + offer.maxGuests + " " + T.guests);
    if (offer.propertyType) factBits.push(offer.propertyType);
    var factsHtml = factBits.length ? '<div class="fact2">' + esc(factBits.join(" · ")) + '</div>' : "";
    var pitch = guestWelcome(offer.name);
    var pitchHtml = pitch ? '<div class="lpitch">' + esc(pitch) + '</div>' : "";

    var sealHtml = '<a id="verifySeal" class="hbcoin" title="' + esc(offer.name) + '" href="' + esc(verifyUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="Verified stay offer">' +
      '<div class="hbcoin-in">' +
        '<div class="hbf"><span>VRP</span></div>' +
        '<div class="hbb" aria-hidden="true"><span>Ed25519</span></div>' +
      '</div></a>';

    var letterInner =
      '<div class="photo" id="photoBox">' + photoHtml + '</div>' +
      '<div class="paper">' +
        '<div>' +
          '<div class="lname">' + esc(offer.name) + '</div>' +
          '<div class="lloc">' + esc(location) + '</div>' +
        '</div>' +
        (matchLine ? '<div class="lmatch">' + esc(matchLine) + '</div>' : "") +
        '<div class="ldates">' + esc(dateLine) + '</div>' +
        cancelHtml +
        '<div class="lrow">' +
          '<span class="price">' + esc(money(offer.finalAmount, offer.currency)) + '</span>' +
          '<a id="bookLink" class="cta" aria-label="Open direct booking URL" href="' + esc(bookUrl) + '" target="_blank" rel="noopener">' + esc(T.cta) + '</a>' +
        '</div>' +
      '</div>';

    var unfoldHtml =
      '<div class="unfold" id="unfoldBox">' +
        '<div class="unfold-in">' + pitchHtml + galHtml + chipsHtml + factsHtml + '</div>' +
      '</div>';

    var lipHtml =
      '<div class="lip">' +
        '<div class="fold-l"></div><div class="fold-r"></div>' +
        '<button id="unfoldBtn" class="lipbtn" aria-expanded="false">' + esc(T.more) + '</button>' +
      '</div>';

    if (isFull) {
      root.className = "";
      root.innerHTML =
        '<div class="stage" style="max-width:520px;">' +
          '<div class="streak" aria-hidden="true"></div>' +
          notice +
          '<div class="full-hero" id="photoBox">' + photoHtml + '</div>' +
          '<div class="letter" style="border-radius:0;min-height:0;">' +
            '<div class="paper">' +
              '<div>' +
                '<div class="lname" style="white-space:normal;">' + esc(offer.name) + '</div>' +
                '<div class="lloc">' + esc(location) + '</div>' +
              '</div>' +
              (matchLine ? '<div class="lmatch" style="-webkit-line-clamp:3;">' + esc(matchLine) + '</div>' : "") +
              '<div class="ldates">' + esc(dateLine) + '</div>' +
              cancelHtml +
              '<div class="lrow">' +
                '<span class="price">' + esc(money(offer.finalAmount, offer.currency)) + '</span>' +
                '<a id="bookLink" class="cta" aria-label="Open direct booking URL" href="' + esc(bookUrl) + '" target="_blank" rel="noopener">' + esc(T.cta) + '</a>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="unfold open" id="unfoldBox" style="max-height:none;">' +
            '<div class="unfold-in">' + pitchHtml + galHtml + chipsHtml + factsHtml + '</div>' +
          '</div>' +
          lipHtml + sealHtml +
        '</div>';
    } else {
      root.className = "";
      root.innerHTML =
        '<div class="stage">' +
          '<div class="streak" aria-hidden="true"></div>' +
          notice +
          '<div class="letter">' + letterInner + '</div>' +
          unfoldHtml + lipHtml + sealHtml +
        '</div>';
    }

    var bookLink = document.getElementById("bookLink");
    if (bookLink) {
      bookLink.addEventListener("click", function (e) {
        if (tryHostOpen(bookUrl)) e.preventDefault();
      });
    }
    var verifySeal = document.getElementById("verifySeal");
    if (verifySeal) {
      verifySeal.addEventListener("click", function (e) {
        if (tryHostOpen(verifyUrl)) e.preventDefault();
      });
    }
    var unfoldBtn = document.getElementById("unfoldBtn");
    var unfoldBox = document.getElementById("unfoldBox");
    if (unfoldBtn && unfoldBox && !isFull) {
      if (hbUnfolded) {
        unfoldBox.style.maxHeight = "420px";
        unfoldBox.classList.add("open");
        unfoldBtn.textContent = T.less;
        unfoldBtn.setAttribute("aria-expanded", "true");
      }
      unfoldBtn.addEventListener("click", function () {
        hbUnfolded = !hbUnfolded;
        unfoldBox.style.maxHeight = hbUnfolded ? "420px" : "0";
        unfoldBox.classList.toggle("open", hbUnfolded);
        unfoldBtn.textContent = hbUnfolded ? T.less : T.more;
        unfoldBtn.setAttribute("aria-expanded", hbUnfolded ? "true" : "false");
      });
    } else if (unfoldBtn && isFull) {
      unfoldBtn.textContent = T.less;
      unfoldBtn.addEventListener("click", function () {
        window.__hbDisplayMode = "inline";
        try {
          if (window.openai && typeof window.openai.requestDisplayMode === "function") {
            window.openai.requestDisplayMode({ mode: "inline" });
          }
        } catch (e) {}
        if (hbLastData) render(hbLastData);
      });
    }
    var photoBox = document.getElementById("photoBox");
    if (photoBox && !isFull) {
      photoBox.addEventListener("click", function () { requestFullscreen(); });
    }
    var heroMain = document.getElementById("heroMain");
    if (heroMain) {
      heroMain.addEventListener("error", function () { heroMain.style.display = "none"; }, { once: true });
    }
    hbCarouselIdx = 0;
    startCarousel(heroMain, heroList);
    root.querySelectorAll(".gthumb").forEach(function (t) {
      t.addEventListener("click", function () {
        if (!heroMain) return;
        heroMain.style.display = "";
        heroMain.src = t.src;
        var at = heroList.indexOf(t.getAttribute("src"));
        if (at >= 0) hbCarouselIdx = at;
        startCarousel(heroMain, heroList);
      });
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
