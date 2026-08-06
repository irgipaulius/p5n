import { attrIcon, typeIconSvg } from "@p5n/sdk";
import PhotoSwipeLightbox from "photoswipe/lightbox";
import "photoswipe/style.css";

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

export const SHARE_ORIGIN = "https://park5night.hyperreader.eu";

export function placeShareUrl(placeId: string): string {
  return `${SHARE_ORIGIN}/${encodeURIComponent(placeId)}`;
}

export function parsePlaceIdFromPath(pathname = location.pathname): string | null {
  const m = pathname.match(/^\/(\d+)\/?$/);
  return m?.[1] ?? null;
}

function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function wazeUrl(lat: number, lng: number): string {
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

function detailActionsHtml(data: PlaceDetail): string {
  if (data.lat == null || data.lng == null) return "";
  const lat = data.lat;
  const lng = data.lng;
  return `<div class="detail-actions">
    <button type="button" class="detail-action" id="btn-share-place" title="Copy link">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
      <span>Share</span>
    </button>
    <a class="detail-action" id="btn-gmaps" href="${escapeHtml(googleMapsUrl(lat, lng))}" target="_blank" rel="noopener noreferrer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>
      <span>Google Maps</span>
    </a>
    <a class="detail-action" id="btn-waze" href="${escapeHtml(wazeUrl(lat, lng))}" target="_blank" rel="noopener noreferrer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>
      <span>Waze</span>
    </a>
    <span class="detail-action-toast" id="share-toast" hidden>Link copied</span>
  </div>`;
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
        `<a href="${escapeHtml(p.large)}" class="carousel-slide${i === 0 ? " active" : ""}" data-i="${i}">
          <img src="${escapeHtml(p.large)}" alt="" loading="${i === 0 ? "eager" : "lazy"}" />
        </a>`,
    )
    .join("");
  const dots =
    photos.length > 1
      ? photos.map((_, i) => `<button type="button" class="carousel-dot${i === 0 ? " active" : ""}" data-i="${i}"></button>`).join("")
      : "";
  return `<div class="photo-carousel pswp-gallery" data-count="${photos.length}">
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
  ${detailActionsHtml(data)}
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

export function initPlaceDetailPanel(root: HTMLElement, data?: PlaceDetail): void {
  if (data) initDetailActions(root, data);

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

  carousel.querySelector(".carousel-prev")?.addEventListener("click", (e) => {
    e.stopPropagation();
    show(idx - 1);
  });
  carousel.querySelector(".carousel-next")?.addEventListener("click", (e) => {
    e.stopPropagation();
    show(idx + 1);
  });
  dots.forEach((d) =>
    d.addEventListener("click", (e) => {
      e.stopPropagation();
      show(Number(d.dataset.i));
    }),
  );

  let touchX = 0;
  carousel.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      touchX = e.touches[0].clientX;
    },
    { passive: true },
  );
  carousel.addEventListener(
    "touchend",
    (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 40) show(idx + (dx < 0 ? 1 : -1));
    },
    { passive: true },
  );

  void initPhotoLightbox(carousel as HTMLElement, slides);
}

function initDetailActions(root: HTMLElement, data: PlaceDetail): void {
  const shareBtn = root.querySelector<HTMLButtonElement>("#btn-share-place");
  const toast = root.querySelector<HTMLElement>("#share-toast");
  shareBtn?.addEventListener("click", () => {
    void (async () => {
      const url = placeShareUrl(data.place_id);
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      if (toast) {
        toast.hidden = false;
        window.setTimeout(() => {
          toast.hidden = true;
        }, 2000);
      }
    })();
  });
}

let activeLightbox: PhotoSwipeLightbox | null = null;
const dimensionCache = new Map<string, { w: number; h: number }>();

function slideDimensionsFromImg(img: HTMLImageElement): { w: number; h: number } | null {
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    return { w: img.naturalWidth, h: img.naturalHeight };
  }
  return null;
}

function cacheSlideDimensions(anchor: HTMLAnchorElement, w: number, h: number): void {
  anchor.dataset.pswpWidth = String(w);
  anchor.dataset.pswpHeight = String(h);
  if (anchor.href) dimensionCache.set(anchor.href, { w, h });
}

function probeImageDimensions(src: string): Promise<{ w: number; h: number } | null> {
  const cached = dimensionCache.get(src);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
        const dims = { w: probe.naturalWidth, h: probe.naturalHeight };
        dimensionCache.set(src, dims);
        resolve(dims);
      } else {
        resolve(null);
      }
    };
    probe.onerror = () => resolve(null);
    probe.src = src;
  });
}

async function ensureGalleryDimensions(slides: HTMLElement[]): Promise<void> {
  await Promise.all(
    slides.map(async (slide) => {
      const anchor = slide as HTMLAnchorElement;
      const img = anchor.querySelector("img");
      const fromImg = img ? slideDimensionsFromImg(img) : null;
      if (fromImg) {
        cacheSlideDimensions(anchor, fromImg.w, fromImg.h);
        return;
      }
      const probed = await probeImageDimensions(anchor.href);
      if (probed) cacheSlideDimensions(anchor, probed.w, probed.h);
      if (img) {
        img.addEventListener(
          "load",
          () => {
            const loaded = slideDimensionsFromImg(img);
            if (loaded) cacheSlideDimensions(anchor, loaded.w, loaded.h);
          },
          { once: true },
        );
      }
    }),
  );
}

async function initPhotoLightbox(gallery: HTMLElement, slides: HTMLElement[]): Promise<void> {
  activeLightbox?.destroy();
  await ensureGalleryDimensions(slides);
  activeLightbox = new PhotoSwipeLightbox({
    gallery,
    children: "a.carousel-slide",
    pswpModule: () => import("photoswipe"),
    showHideAnimationType: "zoom",
    initialZoomLevel: "fit",
    secondaryZoomLevel: 2,
    maxZoomLevel: 4,
    bgOpacity: 0.92,
    wheelToZoom: true,
    pinchToClose: true,
    closeOnVerticalDrag: true,
    padding: { top: 20, bottom: 40, left: 20, right: 20 },
  });
  activeLightbox.addFilter("domItemData", (itemData, _element, linkEl) => {
    const w = linkEl.dataset.pswpWidth ? Number(linkEl.dataset.pswpWidth) : 0;
    const h = linkEl.dataset.pswpHeight ? Number(linkEl.dataset.pswpHeight) : 0;
    const img = linkEl.querySelector("img");
    const fromImg = img ? slideDimensionsFromImg(img) : null;
    const width = fromImg?.w || w;
    const height = fromImg?.h || h;
    if (width > 0 && height > 0) {
      itemData.width = width;
      itemData.height = height;
      itemData.w = width;
      itemData.h = height;
    }
    return itemData;
  });
  activeLightbox.addFilter("itemData", (itemData, _index) => {
    if ((!itemData.width || !itemData.height) && itemData.src) {
      const cached = dimensionCache.get(itemData.src);
      if (cached) {
        itemData.width = cached.w;
        itemData.height = cached.h;
        itemData.w = cached.w;
        itemData.h = cached.h;
      }
    }
    return itemData;
  });
  activeLightbox.on("uiRegister", () => {
    activeLightbox?.pswp?.ui?.registerElement({
      name: "carousel-hint",
      order: 9,
      isButton: false,
      appendTo: "wrapper",
      html: '<div class="pswp-carousel-hint">Swipe or use arrows · tap outside to close</div>',
    });
  });
  activeLightbox.init();
}

export async function loadPlaceDetail(apiBase: string, placeId: string, withReviews: boolean): Promise<PlaceDetail> {
  const url = `${apiBase}/api/places/${encodeURIComponent(placeId)}${withReviews ? "?reviews=1" : ""}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as PlaceDetail;
}
