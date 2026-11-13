import * as L from 'leaflet';
import { HomeAssistant } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { SHAPES_PANE, Z_SHAPES } from './const';
import { hideElementWhileZooming } from './hide-while-zooming';

// Shapes overlay: GeoJSON features that another integration publishes on
// an entity's `features` attribute (`shape_entities` in the config). The
// card fetches nothing for this layer; the data owner styles each feature
// through a small allowlist of `properties`, and everything else in a
// feature is ignored. See docs/overlays.md ("Shapes from an entity").
//
// Safety: no property is executed, templated or inserted as HTML. Colors
// must match CSS_COLOR, icons must be `mdi:` names, and labels and popup
// text are set with textContent.

const DEFAULT_COLOR = '#3388ff';
const DEFAULT_WEIGHT = 2;
const DEFAULT_FILL_OPACITY = 0.2;
const MAX_WEIGHT = 20;
const POINT_RADIUS = 6;
const ICON_SIZE = 24;
const MAX_LABEL_CHARS = 80;
const MAX_POPUP_CHARS = 500;
const DASH_PATTERN = '6 6';

// A hex color, a named color, or rgb()/rgba()/hsl()/hsla() with numbers
// only. Anything else falls back to the default rather than reaching the
// renderer.
const CSS_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/deg]+\))$/i;
const MDI_ICON = /^mdi:[a-z0-9-]{1,64}$/;

/** The style a feature asked for, after the allowlist and the range checks. */
export interface ShapeStyle {
  stroke: string;
  fill: string;
  fillOpacity: number;
  weight: number;
  dash: boolean;
  label: string;
  popup: string;
  icon: string | null;
  rank: number;
}

/** One drawable feature: its checked geometry and style, and where it came from. */
export interface ShapeItem {
  entityId: string;
  schema: unknown;
  geometry: GeoJSON.Geometry;
  style: ShapeStyle;
}

function colorOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && CSS_COLOR.test(value.trim()) ? value.trim() : fallback;
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function shortText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Reads the allowlisted style keys from a feature's properties. Unknown
 * keys are ignored; a value of the wrong type or out of range gets the
 * default.
 */
export function shapeStyle(properties: unknown): ShapeStyle {
  const p = (properties && typeof properties === 'object' ? properties : {}) as Record<string, unknown>;
  const stroke = colorOr(p.stroke, DEFAULT_COLOR);
  return {
    stroke,
    fill: colorOr(p.fill, stroke),
    fillOpacity: numberIn(p.fill_opacity, 0, 1, DEFAULT_FILL_OPACITY),
    weight: numberIn(p.weight, 0, MAX_WEIGHT, DEFAULT_WEIGHT),
    dash: p.dash === true,
    label: shortText(p.label, MAX_LABEL_CHARS),
    popup: shortText(p.popup, MAX_POPUP_CHARS),
    icon: typeof p.icon === 'string' && MDI_ICON.test(p.icon) ? p.icon : null,
    rank: numberIn(p.rank, -1e6, 1e6, 0),
  };
}

function isPosition(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [lon, lat] = value;
  return typeof lon === 'number' && typeof lat === 'number'
    && Number.isFinite(lon) && Number.isFinite(lat)
    && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

function isLine(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 2 && value.every(isPosition);
}

// A closed ring has at least four positions, the last repeating the first
// (RFC 7946 section 3.1.6). Leaflet would draw an open ring anyway, but a
// ring that is not closed usually means the data is in the wrong shape.
function isRing(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 4 || !value.every(isPosition)) return false;
  const first = value[0] as number[];
  const last = value[value.length - 1] as number[];
  return first[0] === last[0] && first[1] === last[1];
}

function isPolygon(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.every(isRing);
}

function isListOf(value: unknown, check: (v: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length >= 1 && value.every(check);
}

/**
 * True for the geometry types the layer draws, with valid WGS84
 * `[lon, lat]` coordinates. GeometryCollection is not drawn.
 */
export function isDrawableGeometry(geometry: unknown): geometry is GeoJSON.Geometry {
  if (!geometry || typeof geometry !== 'object') return false;
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  switch (type) {
    case 'Point': return isPosition(coordinates);
    case 'MultiPoint': return isListOf(coordinates, isPosition);
    case 'LineString': return isLine(coordinates);
    case 'MultiLineString': return isListOf(coordinates, isLine);
    case 'Polygon': return isPolygon(coordinates);
    case 'MultiPolygon': return isListOf(coordinates, isPolygon);
    default: return false;
  }
}

/**
 * Reads every configured entity's `features` attribute into drawable
 * items, lowest `rank` first (equal ranks keep their order). `skipped`
 * counts the features that were not valid GeoJSON. A missing entity, or
 * one with no `features` attribute (for example while unavailable), adds
 * nothing and is not an error.
 */
export function collectShapes(
  hass: HomeAssistant | undefined,
  entityIds: readonly string[],
): { items: ShapeItem[]; skipped: number } {
  const items: ShapeItem[] = [];
  let skipped = 0;
  for (const entityId of entityIds) {
    const attributes = hass?.states?.[entityId]?.attributes;
    if (!attributes || attributes.features === undefined) continue;
    if (!Array.isArray(attributes.features)) {
      skipped += 1;
      continue;
    }
    for (const feature of attributes.features as unknown[]) {
      const geometry = (feature as { geometry?: unknown } | null)?.geometry;
      if (!isDrawableGeometry(geometry)) {
        skipped += 1;
        continue;
      }
      const properties = (feature as { properties?: unknown }).properties;
      items.push({ entityId, schema: attributes.schema, geometry, style: shapeStyle(properties) });
    }
  }
  // Array.prototype.sort is stable, so equal ranks keep the entity's order.
  items.sort((a, b) => a.style.rank - b.style.rank);
  return { items, skipped };
}

/**
 * The key the layer redraws on: each configured entity with its
 * `last_updated`. A hass update that leaves every one unchanged (most of
 * them: hass changes whenever any entity in the install does) costs one
 * string compare.
 */
export function shapesDecisionKey(hass: HomeAssistant | undefined, entityIds: readonly string[]): string {
  return entityIds.map((id) => `${id}@${hass?.states?.[id]?.last_updated ?? '-'}`).join('|');
}

/** The configured entity ids, in order, without blanks or repeats. */
export function shapeEntityIds(cfg: WeatherRadarCardConfig): string[] {
  const list = Array.isArray(cfg.shape_entities) ? cfg.shape_entities : [];
  const ids = list.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim());
  return [...new Set(ids)];
}

/** Popup content as DOM nodes: the label in bold, the popup text, and the source entity. */
export function shapePopupContent(item: ShapeItem): HTMLElement {
  const box = document.createElement('div');
  box.className = 'radar-shape-popup';
  if (item.style.label) {
    const title = document.createElement('strong');
    title.textContent = item.style.label;
    box.appendChild(title);
  }
  if (item.style.popup) {
    const body = document.createElement('div');
    body.textContent = item.style.popup;
    box.appendChild(body);
  }
  const source = document.createElement('div');
  source.style.opacity = '0.7';
  source.style.fontSize = 'smaller';
  const schema = typeof item.schema === 'number' || typeof item.schema === 'string' ? ` (schema ${item.schema})` : '';
  source.textContent = `${item.entityId}${schema}`;
  box.appendChild(source);
  return box;
}

function iconFor(item: ShapeItem): L.DivIcon {
  const holder = document.createElement('div');
  const icon = document.createElement('ha-icon');
  icon.setAttribute('icon', item.style.icon ?? '');
  icon.style.color = item.style.stroke;
  holder.appendChild(icon);
  return L.divIcon({
    html: holder,
    className: 'radar-shape-icon',
    iconSize: [ICON_SIZE, ICON_SIZE],
    iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
  });
}

export class ShapesLayer {
  private _map: L.Map;
  private _getConfig: () => WeatherRadarCardConfig;
  private _hass: HomeAssistant | undefined;
  private _group: L.FeatureGroup | null = null;
  private _renderer: L.SVG | null = null;
  private _disposeHide: (() => void) | null = null;
  // The decision key of what is drawn now; null before the first draw.
  private _drawnKey: string | null = null;
  // A redraw that arrived while a popup was open; runs on popupclose.
  private _redrawAfterPopup = false;

  constructor(map: L.Map, getConfig: () => WeatherRadarCardConfig, hass?: HomeAssistant) {
    this._map = map;
    this._getConfig = getConfig;
    this._hass = hass;
  }

  start(): void {
    this._ensurePane();
    // An SVG renderer of its own in the shapes pane, not the shared canvas
    // renderer: a second canvas above the alert polygons would take every
    // click meant for them (see shared-canvas-renderer.ts). The pane has
    // pointer-events none, so only the shapes' own paths and icons take
    // clicks and the rest fall through to the alerts underneath.
    this._renderer = L.svg({ pane: SHAPES_PANE });
    this._group = L.featureGroup().addTo(this._map);
    this._group.on('popupclose', this._onPopupClose);
    this._disposeHide = hideElementWhileZooming(this._map, () => this._map.getPane(SHAPES_PANE));
    this._refresh();
  }

  clear(): void {
    if (this._group) {
      this._group.off('popupclose', this._onPopupClose);
      this._group.clearLayers();
      this._group.remove();
      this._group = null;
    }
    if (this._renderer) {
      this._renderer.remove();
      this._renderer = null;
    }
    this._disposeHide?.();
    this._disposeHide = null;
    this._drawnKey = null;
    this._redrawAfterPopup = false;
  }

  updateHass(hass: HomeAssistant): void {
    this._hass = hass;
    this._refresh();
  }

  private _ensurePane(): void {
    if (this._map.getPane(SHAPES_PANE)) return;
    const pane = this._map.createPane(SHAPES_PANE);
    pane.style.zIndex = String(Z_SHAPES);
    pane.style.pointerEvents = 'none';
  }

  private _onPopupClose = (): void => {
    if (!this._redrawAfterPopup) return;
    // Leaflet fires popupclose from the popup's onRemove, while the popup
    // is still on the map, so _popupOpen() is still true here and
    // _refresh would wait again, forever. Redraw once the close has
    // finished, as the alerts layer does (nws-alerts-layer.ts).
    queueMicrotask(() => {
      if (!this._redrawAfterPopup) return;
      this._redrawAfterPopup = false;
      this._refresh();
    });
  };

  private _popupOpen(): boolean {
    return this._group?.getLayers().some((layer) => layer.isPopupOpen()) ?? false;
  }

  private _refresh(): void {
    if (!this._group) return;
    const ids = shapeEntityIds(this._getConfig());
    const key = shapesDecisionKey(this._hass, ids);
    if (key === this._drawnKey) return;
    // A redraw removes the open popup's layer; wait until it closes.
    if (this._popupOpen()) {
      this._redrawAfterPopup = true;
      return;
    }
    try {
      this._draw(ids);
      this._drawnKey = key;
    } catch (err) {
      // Never let a bad feature escape into the card's Lit lifecycle.
      console.warn('Shapes: draw failed', err);
    }
  }

  private _draw(ids: string[]): void {
    const group = this._group;
    if (!group) return;
    group.clearLayers();
    const { items, skipped } = collectShapes(this._hass, ids);
    if (skipped > 0) {
      console.warn(`Shapes: skipped ${skipped} feature(s) that are not valid GeoJSON in ${ids.join(', ')}`);
    }
    const interactive = this._getConfig().static_map !== true;
    for (const item of items) {
      for (const layer of this._layersFor(item, interactive)) {
        // A static map cannot move, so no popup that would pan it.
        if (interactive) layer.bindPopup(() => shapePopupContent(item), { autoPanPadding: [12, 12] });
        group.addLayer(layer);
      }
    }
  }

  private _layersFor(item: ShapeItem, interactive: boolean): L.Layer[] {
    const { geometry, style } = item;
    if (geometry.type === 'Point' || geometry.type === 'MultiPoint') {
      const points = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
      return points.map(([lon, lat]) => this._pointLayer(item, L.latLng(lat, lon), interactive));
    }
    const pathOptions: L.PathOptions = {
      renderer: this._renderer ?? undefined,
      pane: SHAPES_PANE,
      interactive,
      color: style.stroke,
      weight: style.weight,
      dashArray: style.dash ? DASH_PATTERN : undefined,
      fillColor: style.fill,
      fillOpacity: style.fillOpacity,
      // Lines are never filled, whatever `fill` says.
      fill: geometry.type !== 'LineString' && geometry.type !== 'MultiLineString',
    };
    // The options go to every path L.geoJSON builds (pane and renderer
    // included); `style` alone would not move them into the shapes pane.
    return [L.geoJSON(geometry, pathOptions)];
  }

  private _pointLayer(item: ShapeItem, at: L.LatLng, interactive: boolean): L.Layer {
    if (item.style.icon) {
      return L.marker(at, { icon: iconFor(item), pane: SHAPES_PANE, interactive, keyboard: false });
    }
    return L.circleMarker(at, {
      renderer: this._renderer ?? undefined,
      pane: SHAPES_PANE,
      interactive,
      radius: POINT_RADIUS,
      color: item.style.stroke,
      weight: item.style.weight,
      dashArray: item.style.dash ? DASH_PATTERN : undefined,
      fillColor: item.style.fill,
      fillOpacity: Math.max(item.style.fillOpacity, 0.6),
    });
  }
}
