import { attrIcon, typeIconSvg } from "@p5n/sdk";

interface AttributeDef {
  bit_index: number;
  column_name: "attrs0" | "attrs1";
  key: string;
  label: string;
}

export interface PlacePhoto {
  thumb: string;
  large: string;
}

type PhotoInput = string | PlacePhoto;

function normalizePhotos(raw: PhotoInput[] | undefined): PlacePhoto[] {
  if (!raw?.length) return [];
  return raw.map((p) => (typeof p === "string" ? { thumb: p, large: p } : p)).filter((p) => p.thumb || p.large);
}

export interface PlaceDetail {
  place_id: string;
  name?: string | null;
  type?: string;
  type_label?: string;
  city?: string | null;
  country?: string | null;
  lat?: number;
  lng?: number;
  rating?: number | null;
  review_count?: number;
  photo_count?: number;
  attrs0?: number;
  attrs1?: number;
  detail?: {
    description?: string;
    route?: string | null;
    hauteur_limite?: string | null;
    prix_stationnement?: string | null;
    prix_services?: string | null;
    date_fermeture?: string | null;
    nb_places?: string | null;
    site?: string | null;
    tel?: string | null;
    mail?: string | null;
    nb_photos?: number;
    photos?: PhotoInput[];
  } | null;
  reviews?: Array<{ rating?: number | null; author?: string | null; created_at?: string | null; comment?: string | null }>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function activeFacilities(data: PlaceDetail, defs: AttributeDef[]): AttributeDef[] {
  const a0 = data.attrs0 ?? 0;
  const a1 = data.attrs1 ?? 0;
  const out: AttributeDef[] = [];
  for (const d of defs) {
    if (d.column_name === "attrs0") {
      if (a0 & (1 << d.bit_index)) out.push(d);
    } else if (a1 & (1 << (d.bit_index - 16))) {
      out.push(d);
    }
  }
  return out;
}

function starsHtml(rating: number | null | undefined): string {
  if (rating == null) return `<span class="stars muted">No rating yet</span>`;
  const full = Math.round(rating);
  let s = "";
  for (let i = 1; i <= 5; i++) {
    s += `<span class="star ${i <= full ? "on" : ""}">★</span>`;
  }
  return `<span class="stars">${s}<span class="rating-num">${rating.toFixed(1)}</span></span>`;
}

function fact(icon: string, label: string, value: string): string {
  if (!value) return "";
  return `<div class="fact"><span class="fact-icon">${icon}</span><div><span class="fact-label">${escapeHtml(label)}</span><span class="fact-value">${escapeHtml(value)}</span></div></div>`;
}

function carouselHtml(photos: PlacePhoto[]): string {
  if (!photos.length) return "";
  const slides = photos
    .map(
      (p, i) =>
        `<div class="carousel-slide${i === 0 ? " active" : ""}" data-i="${i}"><img src="${escapeHtml(p.large)}" alt="" loading="${i === 0 ? "eager" : "lazy"}" /></div>`,
    )
    .join("");
  const dots =
    photos.length > 1
      ? photos.map((_, i) => `<button type="button" class="carousel-dot${i === 0 ? " active" : ""}" data-i="${i}"></button>`).join("")
      : "";
  return `<div class="photo-carousel" data-count="${photos.length}">
    ${photos.length > 1 ? `<button type="button" class="carousel-nav carousel-prev" aria-label="Previous">‹</button>` : ""}
    <div class="carousel-track">${slides}</div>
    ${photos.length > 1 ? `<button type="button" class="carousel-nav carousel-next" aria-label="Next">›</button>` : ""}
    ${dots ? `<div class="carousel-dots">${dots}</div>` : ""}
  </div>`;
}

export function renderPlaceDetail(data: PlaceDetail, defs: AttributeDef[], typeInt: number): string {
  const title = escapeHtml(String(data.name || data.place_id));
  const loc = [data.city, data.country].filter(Boolean).join(", ");
  const photos = normalizePhotos(data.detail?.photos);
  const photoCount = data.photo_count ?? data.detail?.nb_photos ?? photos.length;
  const desc = escapeHtml(String(data.detail?.description || "").trim());
  const facilities = activeFacilities(data, defs);
  const reviews = data.reviews ?? [];

  let html = carouselHtml(photos);

  html += `<header class="detail-head">
    <div class="detail-title-row">
      <span class="detail-type-icon">${typeIconSvg(typeInt, 28)}</span>
      <div>
        <h2>${title}</h2>
        <p class="detail-meta">${escapeHtml(data.type_label || data.type || "")}${loc ? ` · ${escapeHtml(loc)}` : ""}</p>
      </div>
    </div>
    <button class="btn-icon" id="btn-close-detail">✕</button>
  </header>
  <div class="detail-body">
    <div class="detail-hero">${starsHtml(data.rating)}</div>
    <div class="fact-grid">
      ${fact("💬", "Reviews", String(data.review_count ?? 0))}
      ${fact("📷", "Photos", String(photoCount))}
      ${fact("📍", "Route", String(data.detail?.route || "").trim())}
      ${fact("🅿", "Spaces", String(data.detail?.nb_places || "").trim())}
      ${fact("📏", "Height limit", data.detail?.hauteur_limite && data.detail.hauteur_limite !== "0.00" ? `${data.detail.hauteur_limite}m` : "")}
      ${fact("💶", "Parking price", String(data.detail?.prix_stationnement || "").trim())}
      ${fact("🔧", "Services price", String(data.detail?.prix_services || "").trim())}
      ${fact("🗓", "Season", String(data.detail?.date_fermeture || "").trim())}
    </div>`;

  if (desc) html += `<p class="detail-desc">${desc}</p>`;

  if (facilities.length) {
    html += `<div class="facility-grid">${facilities.map((f) => `<span class="facility"><span class="facility-icon">${attrIcon(f.key)}</span>${escapeHtml(f.label)}</span>`).join("")}</div>`;
  }

  const contact: string[] = [];
  if (data.detail?.site) contact.push(`<a class="contact-link" href="${escapeHtml(data.detail.site)}" target="_blank" rel="noopener">🌐 Website</a>`);
  if (data.detail?.tel) contact.push(`<a class="contact-link" href="tel:${escapeHtml(data.detail.tel)}">📞 ${escapeHtml(data.detail.tel)}</a>`);
  if (data.detail?.mail) contact.push(`<a class="contact-link" href="mailto:${escapeHtml(data.detail.mail)}">✉ ${escapeHtml(data.detail.mail)}</a>`);
  if (contact.length) html += `<div class="detail-contact">${contact.join("")}</div>`;

  if (reviews.length) {
    html += `<details class="detail-reviews-wrap"><summary>Reviews (${reviews.length})</summary><ul class="detail-reviews">`;
    for (const r of reviews.slice(0, 12)) {
      const stars = r.rating != null ? `${"★".repeat(Math.round(r.rating))}` : "";
      const who = escapeHtml(String(r.author || "Guest"));
      const when = r.created_at ? escapeHtml(String(r.created_at).slice(0, 10)) : "";
      const text = escapeHtml(String(r.comment || "").trim());
      html += `<li><div class="review-head"><strong>${who}</strong> <span class="review-stars">${stars}</span> <span class="muted">${when}</span></div>${text ? `<p>${text}</p>` : ""}</li>`;
    }
    html += `</ul></details>`;
  }

  html += `</div>`;
  return html;
}

export function initPlaceDetailPanel(root: HTMLElement): void {
  const carousel = root.querySelector(".photo-carousel");
  if (!carousel) return;
  const slides = [...carousel.querySelectorAll<HTMLElement>(".carousel-slide")];
  const dots = [...carousel.querySelectorAll<HTMLButtonElement>(".carousel-dot")];
  let idx = 0;

  const show = (i: number) => {
    if (!slides.length) return;
    idx = (i + slides.length) % slides.length;
    slides.forEach((s, n) => s.classList.toggle("active", n === idx));
    dots.forEach((d, n) => d.classList.toggle("active", n === idx));
  };

  carousel.querySelector(".carousel-prev")?.addEventListener("click", () => show(idx - 1));
  carousel.querySelector(".carousel-next")?.addEventListener("click", () => show(idx + 1));
  dots.forEach((d) => d.addEventListener("click", () => show(Number(d.dataset.i))));

  let touchX = 0;
  carousel.addEventListener(
    "touchstart",
    (e) => {
      touchX = e.touches[0].clientX;
    },
    { passive: true },
  );
  carousel.addEventListener(
    "touchend",
    (e) => {
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 40) show(idx + (dx < 0 ? 1 : -1));
    },
    { passive: true },
  );
}

export async function loadPlaceDetail(apiBase: string, placeId: string, withReviews: boolean): Promise<PlaceDetail> {
  const url = `${apiBase}/api/places/${encodeURIComponent(placeId)}${withReviews ? "?reviews=1" : ""}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as PlaceDetail;
}
