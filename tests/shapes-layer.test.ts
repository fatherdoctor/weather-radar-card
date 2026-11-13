// Shapes overlay (shape_entities): which features draw, how the style
// allowlist reads them, when the layer redraws, and where it sits in the
// pane stack, on a real Leaflet map in happy-dom.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as L from 'leaflet';
import type { HomeAssistant } from 'custom-card-helpers';
import {
  ShapesLayer, collectShapes, isDrawableGeometry, shapeEntityIds, shapePopupContent, shapeStyle, shapesDecisionKey,
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
  properties: { fill: 'rgba(255, 0, 0, 0.5)', fill_opacity: 0.3, rank: 1 },
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

  it('adds nothing for a missing entity or one without features, and no warning count', () => {
    expect(collectShapes(hassWith(undefined), ['sensor.geo'])).toEqual({ items: [], skipped: 0 });
    expect(collectShapes(hassWith([line]), ['sensor.absent'])).toEqual({ items: [], skipped: 0 });
    expect(collectShapes(undefined, ['sensor.geo'])).toEqual({ items: [], skipped: 0 });
  });

  it('counts a features attribute that is not a list as one skip', () => {
    expect(collectShapes(hassWith({ type: 'FeatureCollection' }), ['sensor.geo']).skipped).toBe(1);
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
      if ((l.options as { pane?: string }).pane === SHAPES_PANE) out.push(l);
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

  it('survives an entity that disappears', () => {
    const layer = new ShapesLayer(map, () => config, hassWith([line]));
    layer.start();
    layer.updateHass({ states: {} } as unknown as HomeAssistant);
    expect(layersIn(map)).toHaveLength(0);
    layer.clear();
  });
});
