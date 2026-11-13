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
const MAX_SCHEMA_CHARS = 32;
// Each stacking run is one pane, and each run of paths one viewport-sized
// SVG. Features past this many runs are drawn in the last one.
export const MAX_STACKING_RUNS = 20;
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
 * True for a GeoJSON Feature object (RFC 7946 section 3.2) whose geometry
 * the layer can draw. A bare geometry, or an object of another type that
 * happens to carry a `geometry`, is not a Feature.
 */
export function isDrawableFeature(feature: unknown): feature is GeoJSON.Feature {
  if (!feature || typeof feature !== 'object' || Array.isArray(feature)) return false;
  const { type, geometry } = feature as { type?: unknown; geometry?: unknown };
  return type === 'Feature' && isDrawableGeometry(geometry);
}

/**
 * Reads every configured entity's `features` attribute into drawable
 * items, lowest `rank` first (equal ranks keep their order). `skipped`
 * counts the entries that were not valid GeoJSON Features. A missing entity, or
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
      if (!isDrawableFeature(feature)) {
        skipped += 1;
        continue;
      }
      items.push({ entityId, schema: attributes.schema, geometry: feature.geometry, style: shapeStyle(feature.properties) });
    }
  }
  // Array.prototype.sort is stable, so equal ranks keep the entity's order.
  items.sort((a, b) => a.style.rank - b.style.rank);
  return { items, skipped };
}

/**
 * True for a feature with something to show in a popup. A feature with
 * neither `label` nor `popup` is drawn without taking taps, so they reach
 * the alert or map underneath.
 */
export function hasPopupText(item: ShapeItem): boolean {
  return item.style.label !== '' || item.style.popup !== '';
}

/** True for an item drawn as an icon marker rather than an SVG path. */
function drawnAsIcon(item: ShapeItem): boolean {
  const type = item.geometry.type;
  return item.style.icon !== null && (type === 'Point' || type === 'MultiPoint');
}

/**
 * Splits rank-ordered items into stacking runs, lowest first. Paths are
 * drawn in an SVG element and icons as marker elements, and the browser
 * stacks those two kinds by z-index, not by the order they were added, so
 * one rank order across both needs a stacking layer per run (one pane
 * each, see ShapesLayer._runPane). A run is either consecutive paths, which
 * share one SVG and stack in the order they were added, or consecutive
 * icons of the same rank, which Leaflet stacks by latitude like every
 * other marker.
 */
export function stackingRuns(items: readonly ShapeItem[]): ShapeItem[][] {
  const runs: ShapeItem[][] = [];
  let previous: ShapeItem | null = null;
  for (const item of items) {
    const sameRun = previous !== null
      && drawnAsIcon(previous) === drawnAsIcon(item)
      && (!drawnAsIcon(item) || previous.style.rank === item.style.rank);
    if (sameRun) {
      runs[runs.length - 1].push(item);
    } else {
      runs.push([item]);
    }
    previous = item;
  }
  return runs;
}

/**
 * Keeps at most `maxRuns` stacking runs by moving every item past the
 * limit into the last run. Inside that run the icons sit above the paths
 * whatever their ranks. `merged` counts the items that were moved.
 */
export function capRuns(runs: readonly ShapeItem[][], maxRuns = MAX_STACKING_RUNS): { runs: ShapeItem[][]; merged: number } {
  if (runs.length <= maxRuns) return { runs: [...runs], merged: 0 };
  const kept = runs.slice(0, maxRuns - 1);
  const rest = runs.slice(maxRuns - 1).flat();
  kept.push(rest);
  return { runs: kept, merged: rest.length - runs[maxRuns - 1].length };
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
  const schemaText = typeof item.schema === 'number' ? String(item.schema) : shortText(item.schema, MAX_SCHEMA_CHARS);
  const schema = schemaText ? ` (schema ${schemaText})` : '';
  source.textContent = `${item.entityId}${schema}`;
  box.appendChild(source);
  return box;
}

/**
 * Whether a path is drawn with a fill. Leaflet's SVG paths take taps
 * wherever a fill is painted, even a transparent one, so a polygon with
 * `fill_opacity: 0` is drawn as an outline and takes taps on its line only.
 * Lines are never filled, whatever `fill` says.
 */
export function isFilled(geometry: GeoJSON.Geometry, style: ShapeStyle): boolean {
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') return false;
  return style.fillOpacity > 0;
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
  // One SVG renderer per run of paths in the current drawing.
  private _renderers: L.SVG[] = [];
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
    this._removeRenderers();
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

  /**
   * The pane for stacking run `index`, created inside the shapes pane on
   * first use and kept for later drawings. A later run sits above an
   * earlier one. Like its parent, it takes no clicks itself.
   */
  private _runPane(index: number): string {
    const name = `${SHAPES_PANE}-${index}`;
    if (!this._map.getPane(name)) {
      const pane = this._map.createPane(name, this._map.getPane(SHAPES_PANE));
      pane.style.zIndex = String(index + 1);
      pane.style.pointerEvents = 'none';
    }
    return name;
  }

  private _removeRenderers(): void {
    for (const renderer of this._renderers) renderer.remove();
    this._renderers = [];
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
    // Recorded before the draw, so a draw that fails is tried and warned
    // once per entity update, not again on every hass update.
    this._drawnKey = key;
    try {
      this._draw(ids);
    } catch (err) {
      // Never let a bad feature escape into the card's Lit lifecycle.
      console.warn('Shapes: draw failed', err);
    }
  }

  private _draw(ids: string[]): void {
    const group = this._group;
    if (!group) return;
    group.clearLayers();
    this._removeRenderers();
    const { items, skipped } = collectShapes(this._hass, ids);
    if (skipped > 0) {
      console.warn(`Shapes: skipped ${skipped} feature(s) that are not valid GeoJSON Features in ${ids.join(', ')}`);
    }
    const { runs, merged } = capRuns(stackingRuns(items));
    if (merged > 0) {
      console.warn(`Shapes: ${merged} feature(s) past ${MAX_STACKING_RUNS} stacking layers drawn in the top one; icons there sit above paths`);
    }
    const mapTakesTaps = this._getConfig().static_map !== true;
    runs.forEach((run, index) => {
      const pane = this._runPane(index);
      // An SVG renderer of its own, not the shared canvas renderer: a
      // second canvas above the alert polygons would take every click
      // meant for them (see shared-canvas-renderer.ts). The panes have
      // pointer-events none, so only the shapes' own paths and icons take
      // clicks and the rest fall through to the alerts underneath. A run
      // of icons only has no paths and needs none.
      let renderer: L.SVG | undefined;
      if (run.some((item) => !drawnAsIcon(item))) {
        renderer = L.svg({ pane });
        this._renderers.push(renderer);
      }
      for (const item of run) {
        // A static map cannot move, so no popup that would pan it. A shape
        // with nothing to say lets taps through to what is under it.
        const interactive = mapTakesTaps && hasPopupText(item);
        for (const layer of this._layersFor(item, pane, renderer, interactive)) {
          if (interactive) layer.bindPopup(() => shapePopupContent(item), { autoPanPadding: [12, 12] });
          group.addLayer(layer);
        }
      }
    });
  }

  private _layersFor(item: ShapeItem, pane: string, renderer: L.SVG | undefined, interactive: boolean): L.Layer[] {
    const { geometry, style } = item;
    if (geometry.type === 'Point' || geometry.type === 'MultiPoint') {
      const points = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
      return points.map(([lon, lat]) => this._pointLayer(item, L.latLng(lat, lon), pane, renderer, interactive));
    }
    const pathOptions: L.PathOptions = {
      renderer,
      pane,
      interactive,
      color: style.stroke,
      weight: style.weight,
      dashArray: style.dash ? DASH_PATTERN : undefined,
      fillColor: style.fill,
      fillOpacity: style.fillOpacity,
      fill: isFilled(geometry, style),
    };
    // The options go to every path L.geoJSON builds (pane and renderer
    // included); `style` alone would not move them into the shapes pane.
    return [L.geoJSON(geometry, pathOptions)];
  }

  private _pointLayer(item: ShapeItem, at: L.LatLng, pane: string, renderer: L.SVG | undefined, interactive: boolean): L.Layer {
    if (drawnAsIcon(item)) {
      return L.marker(at, { icon: iconFor(item), pane, interactive, keyboard: false });
    }
    return L.circleMarker(at, {
      renderer,
      pane,
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
