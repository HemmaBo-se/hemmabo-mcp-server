#!/usr/bin/env bash
# Render submission/screenshot-property-cards.png (706x600) using pure ImageMagick draw commands.
# Shows 4 mock HemmaBo property cards as the search.properties widget would render them.
set -euo pipefail

OUT="$(dirname "$0")/screenshot-property-cards.png"
FONT="DejaVu-Sans"
FONT_BOLD="DejaVu-Sans-Bold"

# Card geometry: 312x260 with 14px corner radius; 4 cards in 2x2 grid; 24px outer pad, 22px gap.
# Image area: 312x156 at top of card.

# Per-card color (top image area), label (country), title, location, sleeps, list price, deal price, discount badge text.
declare -a CARDS=(
  "1e40af|bfdbfe|SE|Villa Akerlyckan|Skane, Sweden|Sleeps 8|SEK 18,900|SEK 16,200|-14%"
  "b45309|fde68a|SE|Stuga Skane|Skane, Sweden|Sleeps 6|SEK 14,000|SEK 12,600|-10%"
  "15803d|bbf7d0|IT|Casa Toscana|Toscana, Italy|Sleeps 10|EUR 2,400|EUR 2,040|-15%"
  "9f1239|fecdd3|DE|Cabin Bavaria|Bavaria, Germany|Sleeps 4|EUR 1,800|EUR 1,548|-14%"
)

# Start with a flat background canvas
magick -size 706x600 xc:'#f3f4f6' "$OUT"

draw_card() {
  local x=$1 y=$2 imgcolor=$3 labelcolor=$4 cc=$5 title=$6 loc=$7 sleeps=$8 listp=$9 dealp=${10} disc=${11}
  local x2=$((x+312)) y2=$((y+260))
  local imgy2=$((y+156))
  # shadow
  magick "$OUT" -fill 'rgba(0,0,0,0.08)' -draw "roundrectangle $((x+2)),$((y+3)) $((x2+2)),$((y2+3)) 14,14" "$OUT"
  # card body
  magick "$OUT" -fill white -stroke '#e5e7eb' -strokewidth 1 -draw "roundrectangle $x,$y $x2,$y2 14,14" "$OUT"
  # image area top (rounded top corners; bottom corners covered by full-width strip below)
  magick "$OUT" -fill "#$imgcolor" -stroke none -draw "roundrectangle $x,$y $x2,$imgy2 14,14" "$OUT"
  # cover bottom-rounded corners of image area with a flat strip
  magick "$OUT" -fill "#$imgcolor" -draw "rectangle $x,$((imgy2-14)) $x2,$imgy2" "$OUT"
  # country code centered-ish in image
  magick "$OUT" -fill "#$labelcolor" -font "$FONT_BOLD" -pointsize 48 -draw "text $((x+18)),$((y+78)) '$cc'" "$OUT"
  # title
  magick "$OUT" -fill '#111827' -stroke none -font "$FONT_BOLD" -pointsize 15 -draw "text $((x+16)),$((y+186)) '$title'" "$OUT"
  # location
  magick "$OUT" -fill '#6b7280' -font "$FONT" -pointsize 12 -draw "text $((x+16)),$((y+206)) '$loc'" "$OUT"
  # sleeps
  magick "$OUT" -fill '#6b7280' -font "$FONT" -pointsize 12 -draw "text $((x+16)),$((y+222)) '$sleeps'" "$OUT"
  # list price (strikethrough)
  magick "$OUT" -fill '#9ca3af' -font "$FONT" -pointsize 13 -draw "text $((x+16)),$((y+248)) '$listp'" "$OUT"
  # strike line — approx 84px wide for SEK / 76px for EUR; use a fixed 80
  magick "$OUT" -fill '#9ca3af' -draw "rectangle $((x+16)),$((y+243)) $((x+96)),$((y+244))" "$OUT"
  # deal price (bold)
  magick "$OUT" -fill '#111827' -font "$FONT_BOLD" -pointsize 14 -draw "text $((x+100)),$((y+248)) '$dealp'" "$OUT"
  # discount badge background (mint) - placed in lower-right of card
  magick "$OUT" -fill '#d1fae5' -draw "roundrectangle $((x+250)),$((y+234)) $((x+296)),$((y+254)) 10,10" "$OUT"
  magick "$OUT" -fill '#065f46' -font "$FONT_BOLD" -pointsize 11 -draw "text $((x+260)),$((y+248)) '$disc'" "$OUT"
}

# Layout: card1 (24,24); card2 (370,24); card3 (24,308); card4 (370,308)
positions=( "24 24" "370 24" "24 308" "370 308" )

for i in 0 1 2 3; do
  IFS='|' read -ra F <<< "${CARDS[$i]}"
  IFS=' ' read -ra P <<< "${positions[$i]}"
  draw_card "${P[0]}" "${P[1]}" "${F[0]}" "${F[1]}" "${F[2]}" "${F[3]}" "${F[4]}" "${F[5]}" "${F[6]}" "${F[7]}" "${F[8]}"
done

identify "$OUT"
