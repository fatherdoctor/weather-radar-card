// Shapes overlay (shape_entities): which features draw, how the style
// allowlist reads them, when the layer redraws, and where it sits in the
// pane stack, on a real Leaflet map in happy-dom.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as L from 'leaflet';
import type { HomeAssistant } from 'custom-card-helpers';
import {
  MAX_STACKING_RUNS, ShapesLayer, capRuns, collectShapes, hasPopupText, isDrawableFeature, isDrawableGeometry, isFilled,
  shapeEntityIds, shapePopupContent, shapeStyle, shapesDecisionKey, stackingRuns,
} from '../src/shapes-layer';
import { overlayConfigured } from '../src/layer-toggles';
import { SHAPES_PANE, Z_LIGHTNING, Z_SHAPES } from '../src/const';
import type { WeatherRadarCardConfig } from '../src/types';

const cfg = (c: Partial<WeatherRadarCardConfig>) => ({ type: 'custom:weather-radar-card', ...c }) as WeatherRadarCardConfig;

const line: GeoJSON.Feature = {
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[-97.0, 32.0], [-96.5, 32.4]] },
  properties: { stroke: '#ff0000', dash: true, rank: 3, label: 'Projected path' },
};
const polygon: GeoJSON.Feature = {
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 33], [-97, 32]]] },
  properties: { fill: 'rgba(255, 0, 0, 0.5)', fill_opacity: 0.3, rank: 1, label: 'Cone' },
};
const point: GeoJSON.Feature = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-96.8, 32.8] },
  properties: { icon: 'mdi:weather-lightning', popup: 'Closest 0.8 mi', rank: 5 },
};

function hassWith(features: unknown, lastUpdated = '2026-11-12T20:00:00Z', extra: Record<string, unknown> = {}): HomeAssistant {
  return {
    states: {
      'sensor.geo': {
        entity_id: 'sensor.geo',
        state: '3',
        last_updated: lastUpdated,
        attributes: { features, schema: 1, ...extra },
      },
    },
  } as unknown as HomeAssistant;
}

describe('isDrawableGeometry', () => {
  it('accepts every drawable type with [lon, lat] coordinates', () => {
    expect(isDrawableGeometry(line.geometry)).toBe(true);
    expect(isDrawableGeometry(polygon.geometry)).toBe(true);
    expect(isDrawableGeometry(point.geometry)).toBe(true);
    expect(isDrawableGeometry({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] })).toBe(true);
    expect(isDrawableGeometry({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] })).toBe(true);
    expect(isDrawableGeometry({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] })).toBe(true);
  });

  it('refuses broken or unsupported geometry', () => {
    expect(isDrawableGeometry(null)).toBe(false);
    expect(isDrawableGeometry('Point')).toBe(false);
    expect(isDrawableGeometry({ type: 'Point', coordinates: ['a', 1] })).toBe(false);
    expect(isDrawableGeometry({ type: 'Point', coordinates: [200, 10] })).toBe(false);
    expect(isDrawableGeometry({ type: 'Point', coordinates: [10, 95] })).toBe(false);
    expect(isDrawableGeometry({ type: 'Point', coordinates: [NaN, 1] })).toBe(false);
    expect(isDrawableGeometry({ type: 'LineString', coordinates: [[0, 0]] })).toBe(false);
    // Not closed: the last position is not the first.
    expect(isDrawableGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] })).toBe(false);
    expect(isDrawableGeometry({ type: 'MultiPolygon', coordinates: [] })).toBe(false);
    expect(isDrawableGeometry({ type: 'GeometryCollection', geometries: [point.geometry] })).toBe(false);
  });
});

describe('isDrawableFeature', () => {
  it('accepts a Feature with drawable geometry', () => {
    expect(isDrawableFeature(line)).toBe(true);
    expect(isDrawableFeature({ type: 'Feature', geometry: point.geometry })).toBe(true);
  });

  it('refuses an entry that is not a GeoJSON Feature, whatever its geometry', () => {
    expect(isDrawableFeature({ type: 'not-a-feature', geometry: point.geometry })).toBe(false);
    expect(isDrawableFeature({ geometry: point.geometry })).toBe(false);
    expect(isDrawableFeature({ type: 'feature', geometry: point.geometry })).toBe(false);
    expect(isDrawableFeature(point.geometry)).toBe(false);
    expect(isDrawableFeature({ type: 'FeatureCollection', features: [point] })).toBe(false);
    expect(isDrawableFeature([point])).toBe(false);
    expect(isDrawableFeature(null)).toBe(false);
    expect(isDrawableFeature({ type: 'Feature', geometry: null })).toBe(false);
  });
});

describe('shapeStyle', () => {
  it('reads the allowlisted keys', () => {
    const s = shapeStyle({
      stroke: '#abc', fill: 'hsl(120, 50%, 50%)', fill_opacity: 0.4, weight: 3, dash: true,
      label: 'Cone', popup: 'Text', icon: 'mdi:home', rank: 2,
    });
    expect(s).toEqual({
      stroke: '#abc', fill: 'hsl(120, 50%, 50%)', fillOpacity: 0.4, weight: 3, dash: true,
      label: 'Cone', popup: 'Text', icon: 'mdi:home', rank: 2,
    });
  });

  it('gives defaults for missing properties, and fill follows stroke', () => {
    const s = shapeStyle(undefined);
    expect(s.stroke).toBe('#3388ff');
    expect(shapeStyle({ stroke: 'red' }).fill).toBe('red');
    expect(s.dash).toBe(false);
    expect(s.icon).toBeNull();
    expect(s.rank).toBe(0);
  });

  it('refuses values that are not plain colors, icons or numbers', () => {
    const s = shapeStyle({
      stroke: 'url(javascript:alert(1))', fill: 'red; background: url(x)', icon: '<img src=x>',
      weight: 500, fill_opacity: -2, dash: 'yes', rank: 'first',
    });
    expect(s.stroke).toBe('#3388ff');
    expect(s.fill).toBe('#3388ff');
    expect(s.icon).toBeNull();
    expect(s.weight).toBe(20);
    expect(s.fillOpacity).toBe(0);
    expect(s.dash).toBe(false);
    expect(s.rank).toBe(0);
  });

  it('cuts long text', () => {
    expect(shapeStyle({ label: 'x'.repeat(200) }).label).toHaveLength(80);
    expect(shapeStyle({ popup: 'y'.repeat(900) }).popup).toHaveLength(500);
  });

  it('ignores unknown properties', () => {
    expect(shapeStyle({ onclick: 'x', kind: 'cone', template: '{{ 1 }}' })).toEqual(shapeStyle({}));
  });
});

describe('collectShapes', () => {
  it('draws the valid features lowest rank first and counts the rest', () => {
    const hass = hassWith([line, { type: 'Feature', geometry: null }, polygon, 'junk', point]);
    const { items, skipped } = collectShapes(hass, ['sensor.geo']);
    expect(items.map((i) => i.geometry.type)).toEqual(['Polygon', 'LineString', 'Point']);
    expect(skipped).toBe(2);
    expect(items[0].schema).toBe(1);
  });

  it('skips and counts entries whose envelope is not a Feature, and still draws the valid ones', () => {
    const hass = hassWith([
      { type: 'not-a-feature', geometry: point.geometry },
      { geometry: point.geometry },
      point.geometry,
      line,
    ]);
    const { items, skipped } = collectShapes(hass, ['sensor.geo']);
    expect(items.map((i) => i.geometry.type)).toEqual(['LineString']);
    expect(skipped).toBe(3);
  });

  it('adds nothing for a missing entity or one without features, and no warning count', () => {
    expect(collectShapes(hassWith(undefined), ['sensor.geo'])).toEqual({ items: [], skipped: 0 });
    expect(collectShapes(hassWith([line]), ['sensor.absent'])).toEqual({ items: [], skipped: 0 });
    expect(collectShapes(undefined, ['sensor.geo'])).toEqual({ items: [], skipped: 0 });
  });

  it('counts a features attribute that is not a list as one skip', () => {
    expect(collectShapes(hassWith({ type: 'FeatureCollection' }), ['sensor.geo']).skipped).toBe(1);
  });
});

describe('stackingRuns', () => {
  const item = (type: 'Point' | 'LineString', rank: number, icon: string | null = null) => ({
    entityId: 'sensor.geo',
    schema: 1,
    geometry: type === 'Point'
      ? { type: 'Point', coordinates: [0, 0] }
      : { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    style: { ...shapeStyle({ rank }), icon },
  }) as Parameters<typeof stackingRuns>[0][number];

  it('keeps consecutive paths, plain points included, in one run', () => {
    const items = [item('LineString', 0), item('Point', 1), item('LineString', 2)];
    expect(stackingRuns(items)).toEqual([items]);
  });

  it('starts a new run wherever paths and icons alternate', () => {
    const items = [item('LineString', 0), item('Point', 1, 'mdi:home'), item('LineString', 2)];
    expect(stackingRuns(items)).toEqual([[items[0]], [items[1]], [items[2]]]);
  });

  it('keeps icons of one rank together and splits icons of different ranks', () => {
    const items = [item('Point', 1, 'mdi:a'), item('Point', 1, 'mdi:b'), item('Point', 2, 'mdi:c')];
    expect(stackingRuns(items)).toEqual([[items[0], items[1]], [items[2]]]);
  });

  it('gives nothing for nothing', () => {
    expect(stackingRuns([])).toEqual([]);
  });

  it('caps the runs: everything past the limit joins the last run and is counted', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i % 2 ? 'Point' : 'LineString', i, i % 2 ? 'mdi:a' : null));
    const runs = stackingRuns(items);
    expect(runs).toHaveLength(10);
    const capped = capRuns(runs, 4);
    expect(capped.runs).toHaveLength(4);
    expect(capped.runs.slice(0, 3)).toEqual(runs.slice(0, 3));
    expect(capped.runs[3]).toEqual(items.slice(3));
    // Items 4..9 moved into run 3, which already held item 3.
    expect(capped.merged).toBe(6);
    expect(capRuns(runs, 10)).toEqual({ runs, merged: 0 });
  });
});

describe('fill and taps', () => {
  const polygonWith = (properties: Record<string, unknown>) => collectShapes(hassWith([{ ...polygon, properties }]), ['sensor.geo']).items[0];

  it('fills a polygon only when its fill_opacity is above 0, and never a line', () => {
    expect(isFilled(polygon.geometry, shapeStyle({ fill_opacity: 0.3 }))).toBe(true);
    expect(isFilled(polygon.geometry, shapeStyle({}))).toBe(true);
    expect(isFilled(polygon.geometry, shapeStyle({ fill_opacity: 0 }))).toBe(false);
    expect(isFilled(line.geometry, shapeStyle({ fill_opacity: 1 }))).toBe(false);
  });

  it('has popup text only with a label or popup', () => {
    expect(hasPopupText(polygonWith({}))).toBe(false);
    expect(hasPopupText(polygonWith({ label: '  ' }))).toBe(false);
    expect(hasPopupText(polygonWith({ label: 'Cone' }))).toBe(true);
    expect(hasPopupText(polygonWith({ popup: 'Text' }))).toBe(true);
  });
});

describe('config', () => {
  it('reads shape_entities without blanks or repeats', () => {
    expect(shapeEntityIds(cfg({ shape_entities: ['sensor.a', ' ', 'sensor.a', 'sensor.b'] }))).toEqual(['sensor.a', 'sensor.b']);
    expect(shapeEntityIds(cfg({}))).toEqual([]);
    expect(shapeEntityIds(cfg({ shape_entities: 'sensor.a' as unknown as string[] }))).toEqual([]);
  });

  it('gives the Shapes toggle only when an entity is configured', () => {
    expect(overlayConfigured('shapes', cfg({ shape_entities: ['sensor.a'] }), undefined)).toBe(true);
    expect(overlayConfigured('shapes', cfg({ shape_entities: [] }), undefined)).toBe(false);
    expect(overlayConfigured('shapes', cfg({}), undefined)).toBe(false);
  });

  it('keys redraws on last_updated only', () => {
    const a = shapesDecisionKey(hassWith([line]), ['sensor.geo']);
    expect(shapesDecisionKey(hassWith([line, point]), ['sensor.geo'])).toBe(a);
    expect(shapesDecisionKey(hassWith([line], '2026-11-12T20:01:00Z'), ['sensor.geo'])).not.toBe(a);
  });
});

describe('shapePopupContent', () => {
  it('writes the label, the popup text and the source as text, never HTML', () => {
    const [item] = collectShapes(hassWith([{
      type: 'Feature', geometry: point.geometry, properties: { label: '<b>Cell</b>', popup: '<img src=x onerror=alert(1)>' },
    }]), ['sensor.geo']).items;
    const el = shapePopupContent(item);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('<b>Cell</b>');
    expect(el.textContent).toContain('sensor.geo (schema 1)');
  });

  it('cuts a long schema and writes markup in it as text', () => {
    const item = {
      ...collectShapes(hassWith([point]), ['sensor.geo']).items[0],
      schema: `<img src=x onerror=alert(1)>${'z'.repeat(5000)}`,
    };
    const el = shapePopupContent(item);
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('(schema <img src=x');
    expect(el.textContent!.length).toBeLessThan(100);
  });
});

describe('ShapesLayer on a map', () => {
  let el: HTMLDivElement;
  let map: L.Map;
  let config: WeatherRadarCardConfig;

  beforeEach(() => {
    el = document.createElement('div');
    el.style.width = '400px';
    el.style.height = '300px';
    document.body.appendChild(el);
    map = L.map(el).setView([32.5, -96.8], 7);
    config = cfg({ shape_entities: ['sensor.geo'] });
  });

  afterEach(() => {
    map.remove();
    el.remove();
    vi.restoreAllMocks();
  });

  const layersIn = (m: L.Map): L.Layer[] => {
    const out: L.Layer[] = [];
    m.eachLayer((l) => {
      // Leaf shapes only: not the SVG renderer or the L.geoJSON wrapper, which carry the pane option too.
      if (l instanceof L.Renderer || l instanceof L.LayerGroup) return;
      // Each stacking run has its own pane inside the shapes pane, named after it.
      if ((l.options as { pane?: string }).pane?.startsWith(`${SHAPES_PANE}-`)) out.push(l);
    });
    return out;
  };

  it('creates its pane above the alerts (overlayPane, 400) and under lightning, without taking clicks itself', () => {
    expect(400).toBeLessThan(Z_SHAPES);
    expect(Z_SHAPES).toBeLessThan(Z_LIGHTNING);
    const layer = new ShapesLayer(map, () => config, hassWith([line]));
    layer.start();
    const pane = map.getPane(SHAPES_PANE)!;
    expect(pane.style.zIndex).toBe(String(Z_SHAPES));
    expect(pane.style.pointerEvents).toBe('none');
    layer.clear();
  });

  it('draws every valid feature in its pane, an icon point as a marker, and warns once per update for the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = new ShapesLayer(map, () => config, hassWith([line, polygon, point, { geometry: { type: 'Point' } }]));
    layer.start();
    const drawn = layersIn(map);
    expect(drawn.some((l) => l instanceof L.Marker)).toBe(true);
    expect(drawn.some((l) => l instanceof L.Polygon)).toBe(true);
    expect(drawn.filter((l) => l instanceof L.Polyline && !(l instanceof L.Polygon))).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('skipped 1 feature');
    layer.clear();
    expect(layersIn(map)).toHaveLength(0);
  });

  it('stacks a higher-ranked polygon over a lower-ranked icon, and the reverse', () => {
    // The outside review's reproduction (SWU.pr F1): before the fix the icon
    // marker always sat above the SVG, whatever the ranks said.
    const icon = (rank: number) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [-96.8, 32.5] }, properties: { icon: 'mdi:circle', rank },
    });
    const square = (rank: number) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[-97, 32.3], [-96.6, 32.3], [-96.6, 32.7], [-97, 32.7], [-97, 32.3]]] },
      properties: { fill: 'blue', fill_opacity: 1, rank },
    });
    const zOf = (l: L.Layer) => {
      const pane = map.getPane((l.options as { pane: string }).pane)!;
      // Both run panes sit directly inside the shapes pane, so their z-indexes compare.
      expect(pane.parentElement).toBe(map.getPane(SHAPES_PANE));
      expect(pane.style.pointerEvents).toBe('none');
      return Number(pane.style.zIndex);
    };
    const layer = new ShapesLayer(map, () => config, hassWith([icon(0), square(10)]));
    layer.start();
    let marker = layersIn(map).find((l) => l instanceof L.Marker)!;
    let polygonLayer = layersIn(map).find((l) => l instanceof L.Polygon)!;
    expect(zOf(polygonLayer)).toBeGreaterThan(zOf(marker));
    // The polygon's SVG is in its own pane, not the icon's.
    expect(map.getPane((marker.options as { pane: string }).pane)!.querySelector('svg')).toBeNull();

    layer.updateHass(hassWith([icon(10), square(0)], '2026-11-12T20:01:00Z'));
    marker = layersIn(map).find((l) => l instanceof L.Marker)!;
    polygonLayer = layersIn(map).find((l) => l instanceof L.Polygon)!;
    expect(zOf(marker)).toBeGreaterThan(zOf(polygonLayer));
    // The redraw removed the first drawing's SVG: only the polygon's is left.
    expect(map.getPane(SHAPES_PANE)!.querySelectorAll('svg')).toHaveLength(1);
    layer.clear();
    expect(map.getPane(SHAPES_PANE)!.querySelectorAll('svg')).toHaveLength(0);
  });

  it('styles a dashed line and never fills it', () => {
    const layer = new ShapesLayer(map, () => config, hassWith([line]));
    layer.start();
    const path = layersIn(map).find((l) => l instanceof L.Polyline) as L.Polyline;
    expect(path.options.color).toBe('#ff0000');
    expect(path.options.dashArray).toBe('6 6');
    expect(path.options.fill).toBe(false);
    layer.clear();
  });

  it('redraws only when an entity\'s last_updated changes', () => {
    const layer = new ShapesLayer(map, () => config, hassWith([line]));
    layer.start();
    const first = layersIn(map)[0];
    layer.updateHass(hassWith([line, polygon]));
    expect(layersIn(map)[0]).toBe(first);
    layer.updateHass(hassWith([line, polygon], '2026-11-12T20:01:00Z'));
    expect(layersIn(map)).not.toContain(first);
    expect(layersIn(map).some((l) => l instanceof L.Polygon)).toBe(true);
    layer.clear();
  });

  it('waits for an open popup to close before it redraws', async () => {
    const layer = new ShapesLayer(map, () => config, hassWith([polygon]));
    layer.start();
    const shape = layersIn(map).find((l) => l instanceof L.Polygon) as L.Polygon;
    // A tap on the shape opens the popup bound on its L.geoJSON wrapper.
    shape.fire('click', { latlng: L.latLng(32.4, -96.6) }, true);
    expect(el.querySelector('.leaflet-popup')).not.toBeNull();
    layer.updateHass(hassWith([line], '2026-11-12T20:01:00Z'));
    expect(layersIn(map)).toContain(shape);
    map.closePopup();
    await Promise.resolve();
    expect(layersIn(map)).not.toContain(shape);
    expect(layersIn(map).some((l) => l instanceof L.Polyline)).toBe(true);
    layer.clear();
  });

  it('on a static map, draws shapes that take no clicks and open no popups', () => {
    config = cfg({ shape_entities: ['sensor.geo'], static_map: true });
    const layer = new ShapesLayer(map, () => config, hassWith([polygon, point]));
    layer.start();
    const drawn = layersIn(map);
    expect(drawn.length).toBeGreaterThan(0);
    for (const l of drawn) {
      expect((l.options as { interactive?: boolean }).interactive).toBe(false);
      expect(l.getPopup()).toBeUndefined();
    }
    layer.clear();
  });

  it('draws a polygon with fill_opacity 0 as an outline that takes taps on its line only', () => {
    const layer = new ShapesLayer(map, () => config, hassWith([{ ...polygon, properties: { label: 'Ring', fill_opacity: 0 } }]));
    layer.start();
    const shape = layersIn(map).find((l) => l instanceof L.Polygon) as L.Polygon;
    expect(shape.options.fill).toBe(false);
    expect(shape.options.interactive).toBe(true);
    // SVG paths take pointer events where a fill is painted; none is.
    expect(shape.getElement()!.getAttribute('fill')).toBe('none');
    layer.clear();
  });

  it('draws a feature with neither label nor popup so it takes no taps and has no popup', () => {
    const quiet = { ...polygon, properties: { fill_opacity: 0.3 } };
    const quietPoint = { ...point, properties: { icon: 'mdi:home' } };
    const quietDot = { type: 'Feature', geometry: { type: 'Point', coordinates: [-96.7, 32.7] }, properties: {} };
    const layer = new ShapesLayer(map, () => config, hassWith([quiet, quietPoint, quietDot, line]));
    layer.start();
    const drawn = layersIn(map);
    expect(drawn).toHaveLength(4);
    for (const l of drawn) {
      // The line has a label; the other three have nothing to say.
      const talks = l instanceof L.Polyline && !(l instanceof L.Polygon);
      expect((l.options as { interactive?: boolean }).interactive).toBe(talks);
    }
    const shape = drawn.find((l) => l instanceof L.Polygon) as L.Polygon;
    expect(shape.getElement()!.classList.contains('leaflet-interactive')).toBe(false);
    shape.fire('click', { latlng: L.latLng(32.4, -96.6) }, true);
    expect(el.querySelector('.leaflet-popup')).toBeNull();
    layer.clear();
  });

  it('tries a draw that fails once per entity update, not on every hass update', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const draw = vi.spyOn(ShapesLayer.prototype as unknown as { _draw: () => void }, '_draw')
      .mockImplementation(() => { throw new Error('boom'); });
    const layer = new ShapesLayer(map, () => config, hassWith([line]));
    layer.start();
    layer.updateHass(hassWith([line]));
    layer.updateHass(hassWith([line]));
    expect(draw).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    layer.updateHass(hassWith([line], '2026-11-12T20:01:00Z'));
    expect(draw).toHaveBeenCalledTimes(2);
    layer.clear();
  });

  it('never makes more stacking panes than the limit, and warns about the features it merged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: 60 }, (_, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-96.8 + i / 100, 32.5] },
      properties: i % 2 ? { icon: 'mdi:circle', rank: i, label: 'i' } : { rank: i, label: 'p' },
    }));
    const layer = new ShapesLayer(map, () => config, hassWith(many));
    layer.start();
    const panes = map.getPane(SHAPES_PANE)!.children;
    expect(panes).toHaveLength(MAX_STACKING_RUNS);
    expect(layersIn(map)).toHaveLength(60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`${60 - MAX_STACKING_RUNS} feature(s) past ${MAX_STACKING_RUNS}`);
    // The merged run mixes icons and paths, so it has an SVG of its own.
    expect(panes[MAX_STACKING_RUNS - 1].querySelector('svg')).not.toBeNull();
    // Every path has the layer's own SVG renderer, never the map's default
    // (which can be a canvas that would take every tap in the pane).
    const paths = layersIn(map).filter((l) => l instanceof L.Path) as L.Path[];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.options.renderer).toBeInstanceOf(L.SVG);
    layer.clear();
  });

  it('starts, clears and starts again: nothing is left after a clear, and the pane is visible', () => {
    const layer = new ShapesLayer(map, () => config, hassWith([line, polygon]));
    layer.start();
    const pane = map.getPane(SHAPES_PANE)!;
    map.fire('zoomstart');
    expect(pane.style.display).toBe('none');
    layer.clear();
    expect(pane.style.display).toBe('');
    expect(layersIn(map)).toHaveLength(0);
    expect(pane.querySelectorAll('path')).toHaveLength(0);
    expect(pane.querySelectorAll('svg')).toHaveLength(0);
    let groups = 0;
    map.eachLayer((l) => { if (l instanceof L.FeatureGroup) groups += 1; });
    expect(groups).toBe(0);
    // The zoom handler went with the clear.
    map.fire('zoomstart');
    expect(pane.style.display).toBe('');
    // Same hass, same key: the new start draws anyway.
    layer.start();
    expect(layersIn(map).some((l) => l instanceof L.Polygon)).toBe(true);
    expect(layersIn(map).some((l) => l instanceof L.Polyline && !(l instanceof L.Polygon))).toBe(true);
    layer.clear();
  });

  it('survives an entity that disappears', () => {
    const layer = new ShapesLayer(map, () => config, hassWith([line]));
    layer.start();
    layer.updateHass({ states: {} } as unknown as HomeAssistant);
    expect(layersIn(map)).toHaveLength(0);
    layer.clear();
  });
});
