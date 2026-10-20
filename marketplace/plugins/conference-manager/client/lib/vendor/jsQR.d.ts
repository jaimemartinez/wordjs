/** Types of the vendored jsQR 1.4.0 (./jsQR.js), the part the scanner uses. */
export interface QRCode {
    binaryData: number[];
    data: string;
    version: number;
}
export interface Options {
    inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst';
}
declare function jsQR(data: Uint8ClampedArray, width: number, height: number, providedOptions?: Options): QRCode | null;
export default jsQR;
