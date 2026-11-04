/**
 * WGS84 → GCJ02, adapted from https://github.com/wandergis/coordtransform.
 * Approximate conversion, performed only on the device after privacy matching.
 *
 * The MIT License (MIT)
 * Copyright (c) 2015 记忆的残骸
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export function wgs84ToAmap(longitude: number, latitude: number): [number, number] {
    if (!(longitude > 73.66 && longitude < 135.05 && latitude > 3.86 && latitude < 53.55)) return [longitude, latitude];
    const x = longitude - 105, y = latitude - 35, pi = Math.PI;
    const xWave = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
    const latitudeShift = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)) + xWave
        + (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3
        + (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
    const longitudeShift = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)) + xWave
        + (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3
        + (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
    const rad = latitude / 180 * pi;
    const eccentricity = 0.00669342162296594323, axis = 6378245;
    const magic = 1 - eccentricity * Math.sin(rad) ** 2, root = Math.sqrt(magic);
    return [longitude + longitudeShift * 180 / (axis / root * Math.cos(rad) * pi),
        latitude + latitudeShift * 180 / ((axis * (1 - eccentricity)) / (magic * root) * pi)];
}
