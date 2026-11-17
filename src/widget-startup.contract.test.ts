import assert from "node:assert/strict";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { parseFragment } from "parse5";
import { readResource } from "../api/mcp.js";
import { HEMMABO_NATIVE_WIDGET_URI, HEMMABO_WIDGET_URI } from "../lib/apps-widget.js";

const offer = {
  domain: "villaakerlyckan.se",
  property: { name: "Villa Åkerlyckan" },
  direct_booking_url: "https://villaakerlyckan.se/book?guests=2",
  price: { total: 11210, currency: "SEK" },
  language: "sv",
  verified: true,
};

type Message = { method: string; id?: number };

for (const delivery of ["preloaded", "late globals", "late tool-result", "Claude tool-result"] as const) {
  it(`initializes once and renders the stay offer with ${delivery}`, () => {
    const uri = delivery === "Claude tool-result" ? HEMMABO_WIDGET_URI : HEMMABO_NATIVE_WIDGET_URI;
    const html = readResource(uri)!.contents[0].text;
    const script = parseFragment(html).childNodes.find(node => node.nodeName === "script");
    assert.ok(script && "childNodes" in script, "served widget must include its inline script");
    const source = script.childNodes[0];
    assert.ok(source && "value" in source, "inline script must contain JavaScript");

    const messages: Message[] = [];
    const window = Object.assign(new EventTarget(), {
      parent: { postMessage: (message: Message) => messages.push(message) },
      openai: delivery === "preloaded" ? { toolOutput: offer } : undefined,
    });
    const root = { innerHTML: "", textContent: "", querySelectorAll: () => [] };
    const document = { getElementById: (id: string) => id === "root" ? root : null };
    const receive = (data: object) => window.dispatchEvent(Object.assign(new Event("message"), {
      data: { jsonrpc: "2.0", ...data }, source: window.parent,
    }));
    const assertCard = () => {
      assert.ok(root.innerHTML.includes(offer.property.name));
      assert.match(root.innerHTML, /class="price">11\s210\skr</);
      assert.match(root.innerHTML, /id="bookLink"[^>]+href="https:\/\/villaakerlyckan\.se\/book\?guests=2"/);
    };

    runInNewContext(source.value, { window, document, URL });
    if (delivery === "preloaded") assertCard();
    else assert.equal(root.innerHTML, "");

    assert.deepEqual(messages.map(m => m.method), ["ui/initialize"]);
    const id = messages[0].id;
    assert.equal(typeof id, "number");
    receive({ id: 99, result: {} });
    assert.equal(messages.length, 1, "ignore responses to other requests");
    receive({ id, result: { protocolVersion: "2026-01-26" } });
    receive({ id, result: { protocolVersion: "2026-01-26" } });

    if (delivery === "late globals") {
      window.dispatchEvent(Object.assign(new Event("openai:set_globals"), {
        detail: { globals: { toolOutput: offer } },
      }));
    } else if (delivery !== "preloaded") {
      receive({ method: "ui/notifications/tool-result", params: { structuredContent: offer } });
    }
    assertCard();
    assert.deepEqual(messages.map(m => m.method), ["ui/initialize", "ui/notifications/initialized"]);
  });
}
