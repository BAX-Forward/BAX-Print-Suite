import { readFileSync } from 'node:fs';
import { ValidationError } from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import { deltaE2000, findSpot, nearestSpots, parseCxfSpotLibrary } from '../src/index.js';

const FIXTURE = readFileSync(new URL('./fixtures/spot-colors.cxf', import.meta.url), 'utf8');

function cxf(objects: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<cc:CxF xmlns:cc="http://colorexchangeformat.com/CxF3-core"><cc:Resources><cc:ObjectCollection>',
    objects,
    '</cc:ObjectCollection></cc:Resources></cc:CxF>',
  ].join('\n');
}

function labObject(name: string, L: number, a: number, b: number): string {
  return (
    `<cc:Object ObjectType="Standard" Name="${name}"><cc:ColorValues>` +
    `<cc:ColorCIELab><cc:L>${L}</cc:L><cc:A>${a}</cc:A><cc:B>${b}</cc:B></cc:ColorCIELab>` +
    '</cc:ColorValues></cc:Object>'
  );
}

describe('CxF spot library', () => {
  it('parses named Lab colours with optional CMYK fallbacks', () => {
    const library = parseCxfSpotLibrary(FIXTURE, ' Test Library ');
    expect(library.name).toBe('Test Library');
    expect(library.colors.map((c) => c.name)).toEqual(['Brand Red', 'Harbor Blue', 'Leaf & Stem Green', 'Warm Sand']);
    expect(library.colors[0]).toEqual({ name: 'Brand Red', lab: { L: 48, a: 68, b: 48 }, cmykFallback: [0, 90, 85, 5] });
    expect(library.colors[1]).toEqual({ name: 'Harbor Blue', lab: { L: 38, a: 5, b: -48 } });
    expect(library.colors[1]?.cmykFallback).toBeUndefined();
    expect(library.colors[2]?.cmykFallback).toEqual([75, 10, 95, 0]);
  });

  it('rejects duplicate names, comparing them normalised', () => {
    const xml = cxf(labObject('Brand Red', 48, 68, 48) + labObject('brand   RED', 50, 60, 40));
    expect(() => parseCxfSpotLibrary(xml, 'dup')).toThrow(ValidationError);
    expect(() => parseCxfSpotLibrary(xml, 'dup')).toThrow(/duplicate spot color name brand {3}RED/);
  });

  it('rejects an object without a Lab value, naming it', () => {
    const spectralOnly =
      '<cc:Object ObjectType="Standard" Name="Spectral Teal"><cc:ColorValues>' +
      '<cc:ReflectanceSpectrum StartWL="400">0.2 0.4 0.5</cc:ReflectanceSpectrum>' +
      '</cc:ColorValues></cc:Object>';
    const xml = cxf(labObject('Brand Red', 48, 68, 48) + spectralOnly);
    expect(() => parseCxfSpotLibrary(xml, 'missing')).toThrow(ValidationError);
    expect(() => parseCxfSpotLibrary(xml, 'missing')).toThrow(/Spectral Teal has no ColorCIELab/);
  });

  it('rejects a non-numeric Lab component, naming the object', () => {
    const xml = cxf(labObject('Brand Red', 48, 68, 48).replace('<cc:B>48</cc:B>', '<cc:B>red</cc:B>'));
    expect(() => parseCxfSpotLibrary(xml, 'bad')).toThrow(/Brand Red has no numeric B value/);
  });

  it('rejects out-of-range Lab and CMYK values, naming the object', () => {
    expect(() => parseCxfSpotLibrary(cxf(labObject('Too Bright', 101, 0, 0)), 'range')).toThrow(/Too Bright has L\* 101/);
    expect(() => parseCxfSpotLibrary(cxf(labObject('Too Green', 50, -129, 0)), 'range')).toThrow(/Too Green has a\* -129/);
    const overInked = labObject('Over Inked', 50, 0, 0).replace(
      '</cc:ColorValues>',
      '<cc:ColorCMYK><cc:Cyan>0</cc:Cyan><cc:Magenta>120</cc:Magenta><cc:Yellow>0</cc:Yellow><cc:Black>0</cc:Black></cc:ColorCMYK></cc:ColorValues>',
    );
    expect(() => parseCxfSpotLibrary(cxf(overInked), 'range')).toThrow(ValidationError);
    expect(() => parseCxfSpotLibrary(cxf(overInked), 'range')).toThrow(/Over Inked has Magenta 120/);
  });

  it('rejects unnamed objects, an empty library name and a document without colours', () => {
    const unnamed = labObject('x', 50, 0, 0).replace(' Name="x"', ' Id="o7"');
    expect(() => parseCxfSpotLibrary(cxf(unnamed), 'lib')).toThrow(/object o7 has no Name/);
    expect(() => parseCxfSpotLibrary(FIXTURE, '  ')).toThrow(ValidationError);
    expect(() => parseCxfSpotLibrary(cxf(''), 'lib')).toThrow(/no named colors/);
    expect(() => parseCxfSpotLibrary('<Other/>', 'lib')).toThrow(/root element must be CxF/);
  });

  it('finds colours ignoring case and whitespace differences', () => {
    const library = parseCxfSpotLibrary(FIXTURE, 'lib');
    expect(findSpot(library, 'Brand Red')?.name).toBe('Brand Red');
    expect(findSpot(library, '  brand \t RED\n')?.name).toBe('Brand Red');
    expect(findSpot(library, 'LEAF  &  stem green')?.name).toBe('Leaf & Stem Green');
    expect(findSpot(library, 'Brand')).toBeUndefined();
    expect(findSpot(library, 'BrandRed')).toBeUndefined();
  });

  it('orders nearest colours by CIEDE2000', () => {
    const library = parseCxfSpotLibrary(FIXTURE, 'lib');
    const query = { L: 50, a: 64, b: 44 };
    const all = nearestSpots(library, query, 10);
    expect(all).toHaveLength(4);
    expect(all[0]?.color.name).toBe('Brand Red');
    for (const match of all) expect(match.deltaE).toBeCloseTo(deltaE2000(query, match.color.lab), 12);
    for (let i = 1; i < all.length; i++) expect(all[i]?.deltaE ?? 0).toBeGreaterThanOrEqual(all[i - 1]?.deltaE ?? Infinity);

    const blueish = nearestSpots(library, { L: 40, a: 3, b: -45 }, 2);
    expect(blueish.map((m) => m.color.name)[0]).toBe('Harbor Blue');
    expect(blueish).toHaveLength(2);
    expect(nearestSpots(library, query, 0)).toEqual([]);
    expect(() => nearestSpots(library, query, -1)).toThrow(RangeError);
    expect(() => nearestSpots(library, query, 1.5)).toThrow(RangeError);
  });
});
