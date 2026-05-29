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
    padding: 12px;
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
  .empty {
    padding: 18px;
    color: var(--muted);
    font-size: 13px;
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
<div id="root" class="empty">Loading HemmaBo stay offer...</div>
<script>
  var VILLA_IMAGE = "https://vfalgymbhyfqsyxkvpqg.supabase.co/storage/v1/object/public/property-images/properties/3ef1d46d-5c23-46fe-86cb-8e714abf734f/other/1777524437024-rewm-2-desktop.jpg?quality=75&resize=cover&width=800";
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

  function render(data) {
    var root = document.getElementById("root");
    if (!data) {
      root.className = "empty";
      root.textContent = "Run a host-domain search or verified stay offer tool to show the stay widget.";
      return;
    }
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
    var heroImages = asArray(offer.images).length ? asArray(offer.images) : (offer.image ? [offer.image] : []);
    var heroImage = heroImages.map(function (src, index) {
      return '<img class="' + (index === 0 ? "active" : "") + '" src="' + esc(src) + '" alt="" aria-hidden="true" loading="' + (index === 0 ? "eager" : "lazy") + '" referrerpolicy="no-referrer">';
    }).join("");
    root.className = "shell";
    root.innerHTML =
      '<section class="hero">' +
        heroImage +
        '<div class="heroCopy">' +
          '<div class="verifiedPill"><span class="dot"></span>' + (offer.verified ? "Host-domain verified" : "Host-domain source") + '</div>' +
          '<h1>' + esc(offer.name) + '</h1>' +
          '<div class="subline"><span>' + esc(location || cleanDomain(offer.domain)) + '</span><span>' + esc(facts.slice(1).join(" - ")) + '</span></div>' +
        '</div>' +
      '</section>' +
      '<section class="trust">' +
        '<div class="trustItem"><span class="icon">V</span><span>Host node<br>' + esc(offer.domain || "verified domain") + '</span></div>' +
        '<div class="trustItem"><span class="icon">L</span><span>Live availability<br>from source</span></div>' +
        '<div class="trustItem"><span class="icon">D</span><span>Direct booking<br>host domain</span></div>' +
        '<div class="trustItem"><span class="icon">S</span><span><span class="stripe">stripe</span><br>host payment path</span></div>' +
      '</section>' +
      '<section class="content">' +
        notice +
        '<div class="offer">' +
          '<div class="offerPanel">' +
            '<p class="label">' + (offer.verified ? "Verified stay offer" : "Host-domain stay option") + '</p>' +
            '<p class="dates">' + esc(formatRange(offer.checkIn, offer.checkOut)) + '</p>' +
            '<div class="facts">' + facts.map(function (f) { return '<span class="fact">' + esc(f) + '</span>'; }).join("") + '</div>' +
            '<div class="priceBox">' +
              '<div class="price">' + esc(money(offer.finalAmount, offer.currency)) + '</div>' +
              '<div class="priceCaption">Final price from host source</div>' +
            '</div>' +
          '</div>' +
          '<div class="offerPanel actions">' +
            '<div class="acp">' +
              '<div class="acpTitle"><span>Signed direct booking</span><span class="stripe">host</span></div>' +
              '<div class="acpCopy">Open the signed host-domain booking URL. Payment happens on the host payment path.</div>' +
            '</div>' +
            '<button class="primary" id="bookBtn">Open direct booking URL</button>' +
            '<button class="secondary" id="openBtn">Open host node</button>' +
          '</div>' +
        '</div>' +
      '</section>' +
      '<section class="tools">' +
        '<div class="toolHead"><strong>Host-domain tools</strong><span class="toolCount">VRP + direct host-domain booking</span></div>' +
        '<div class="toolGrid">' + TOOL_LABELS.map(function (label) { return '<span class="toolChip">' + esc(label) + '</span>'; }).join("") + '</div>' +
      '</section>';
    var bookBtn = document.getElementById("bookBtn");
    var openBtn = document.getElementById("openBtn");
    if (bookBtn) {
      bookBtn.addEventListener("click", function () {
        openExternal(offer.directUrl || hostUrl(offer.domain));
      });
    }
    if (openBtn) {
      openBtn.addEventListener("click", function () {
        openExternal(offer.directUrl || hostUrl(offer.domain));
      });
    }
    var slides = root.querySelectorAll(".hero img");
    slides.forEach(function (slide) {
      slide.addEventListener("error", function () {
        slide.remove();
      }, { once: true });
    });
    if (window.__hemmaboHeroTimer) window.clearInterval(window.__hemmaboHeroTimer);
    if (slides.length > 1) {
      var activeIndex = 0;
      window.__hemmaboHeroTimer = window.setInterval(function () {
        if (!slides.length) return;
        slides[activeIndex % slides.length].classList.remove("active");
        activeIndex = (activeIndex + 1) % slides.length;
        slides[activeIndex].classList.add("active");
      }, 4500);
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/tool-result") {
      render(message.params && enrichData(message.params.structuredContent || parseContent(message.params.content), message.params._meta));
    }
  }, { passive: true });

  window.addEventListener("openai:set_globals", function (event) {
    var globals = event && event.detail && event.detail.globals;
    if (!globals) return;
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

  render(getData());
</script>
</body>
</html>`;
