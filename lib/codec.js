var debug       = require('debug')('amqp10-Codec'),
    util        = require('util'),
    butils      = require('butils'),
    CBuffer     = require('cbarrick-circular-buffer'),
    builder     = require('buffer-builder'),
    Int64       = require('node-int64'),

    constants   = require('./constants'),
    DescribedType = require('./described_type'),
    ForcedType  = require('./forced_type'),
    exceptions  = require('./exceptions'),
    types       = require('./types');


/**
 * Build a codec.
 *
 * @constructor
 */
var Codec = function() {
};

/**
 * Acquired from http://stackoverflow.com/questions/3885817/how-to-check-if-a-number-is-float-or-integer
 *
 * @param {number} n        Number to test.
 * @returns {boolean}       True if integral.
 * @private
 */
Codec.prototype._isInteger = function(n) {
    return n === +n && n === (n|0);
};

Codec.prototype._remaining = function(buf, offset) {
    return buf.length - offset;
};

Codec.prototype._peek = function(buf, offset, numBytes) {
    return (buf instanceof CBuffer) ? buf.peek(numBytes + offset).slice(offset) : buf.slice(offset, offset + numBytes);
};

Codec.prototype._read = function(buf, offset, numBytes) {
    return (buf instanceof CBuffer) ? buf.read(numBytes + offset).slice(offset) : buf.slice(offset, offset + numBytes);
};

/**
 * Reads a full value's worth of bytes from a circular or regular buffer, or returns undefined if not enough bytes are there.
 * Note that for Buffers, the returned Buffer will be a slice (so backed by the original storage)!
 *
 * @param {Buffer|CBuffer} buf              Buffer or circular buffer to read from.  If a Buffer is given, it is assumed to be full.
 * @param {integer} [offset=0]              Offset - only valid for Buffer, not CBuffer.
 * @param {boolean} [doNotConsume=false]    If set to true, will peek bytes instead of reading them - useful for leaving
 *                                          circular buffer in original state for described values that are not yet complete.
 * @returns {Array}                         Buffer of full value + number of bytes read.
 *                                          For described types, will return [ [ descriptor-buffer, value-buffer ], total-bytes ].
 * @private
 */
Codec.prototype._readFullValue = function(buf, offset, doNotConsume) {
    offset = offset || 0;

    var self = this;
    var remaining = this._remaining(buf, offset);
    if (remaining < 1) return undefined;

    var code = this._peek(buf, offset, 1);
    // Constructor - need to read two full values back to back of unknown size.  (╯°□°）╯︵ ┻━┻
    if (code[0] === 0x00) {
        var val1 = this._readFullValue(buf, offset + 1, true);
        if (val1 !== undefined) {
            var val2 = this._readFullValue(buf, offset + 1 + val1[1], true);
            if (val2 !== undefined) {
                // Now, consume the bytes
                var totalBytes = val1[1] + val2[1] + 1;
                this._read(buf, offset, totalBytes);
                return [ [val1[0], val2[0]], totalBytes];
            }
        }
        return undefined;
    }

    var codePrefix = code[0] & 0xF0;
    var codeAndLength, numBytes;
    var reader = doNotConsume ? self._peek : self._read;
    var readFixed = function(nBytes) { return remaining >= nBytes ? [ reader(buf, offset, nBytes), nBytes ] : undefined; };
    switch (codePrefix) {
        case 0x40: return readFixed(1);
        case 0x50: return readFixed(2);
        case 0x60: return readFixed(3);
        case 0x70: return readFixed(5);
        case 0x80: return readFixed(9);
        case 0x90: return readFixed(17);
        case 0xA0:
        case 0xC0:
        case 0xE0:
            if (remaining < 2) return undefined;
            codeAndLength = this._peek(buf, offset, 2);
            numBytes = codeAndLength[1] + 2; // code + size + # octets
            debug('Reading variable 0x'+codePrefix.toString(16)+' of length '+numBytes);
            return remaining >= numBytes ? [ reader(buf, offset, numBytes), numBytes ] : undefined;
        case 0xB0:
        case 0xD0:
        case 0xF0:
            if (remaining < 5) return false;
            codeAndLength = this._peek(buf, offset, 5);
            numBytes = butils.readInt32(codeAndLength, 1) + 5; // code + size + #octets
            debug('Reading variable 0x'+codePrefix.toString(16)+' of length '+numBytes);
            return remaining >= numBytes ? [ reader(buf, offset, numBytes), numBytes ] : undefined;

        default:
            throw new exceptions.MalformedPayloadError('Unknown code prefix: 0x' + codePrefix.toString(16));
    }
};

/**
 * Decode a single entity from a buffer (starting at offset 0).  Only simple values currently supported.
 *
 * @param {Buffer|CBuffer} buf          The buffer/circular buffer to decode.  Will decode a single value per call.
 * @param {integer} [offset=0]          The offset to read from (only used for Buffers).
 * @return {Array}                      Single decoded value + number of bytes consumed.
 */
Codec.prototype.decode = function(buf, offset) {
    var fullBuf = this._readFullValue(buf, offset);
    if (fullBuf) {
        var bufVal = fullBuf[0];
        var numBytes = fullBuf[1];
        if (bufVal instanceof Array) {
            // Described type
            debug('Decoding described type...');
            var descriptor = this.decode(bufVal[0], 0);
            var value = this.decode(bufVal[1], 0);
            return [ new DescribedType(descriptor[0], value[0]), numBytes ];
        }

        debug('Decoding '+bufVal.toString('hex'));
        var code = fullBuf[0][0];
        var decoder = types.decoders[code];
        if (!decoder) {
            throw new exceptions.MalformedPayloadError('Unknown code: 0x' + code.toString(16));
        } else {
            return [ decoder(bufVal.slice(1), this), numBytes ];
        }
    }

    /** @todo debug unmatched */
    return undefined;
};

/**
 * Encode the given value as an AMQP 1.0 bitstring.
 *
 * We do a best-effort to determine type.  Objects will be encoded as <code>maps</code>, unless:
 * + They are DescribedTypes, in which case they will be encoded as such.
 * + They contain an encodeOrdering array, in which case they will be encoded as a <code>list</code> of their values
 *   in the specified order.
 * + They are Int64s, in which case they will be encoded as <code>longs</code>.
 *
 * @param val                           Value to encode.
 * @param {builder} buf                 buffer-builder to write into.
 * @param {string} [forceType]          If set, forces the encoder for the given type.
 */
Codec.prototype.encode = function(val, buf, forceType) {
    var type = typeof val;
    var encoder;
    // Special-case null values
    if (val === null) {
        encoder = types.builders.null;
        return encoder(val, buf);
    }

    switch (type) {
        case 'string':
            encoder = types.builders[forceType || 'string'];
            return encoder(val, buf);

        case 'number':
            var typeName = 'double';
            if (forceType) {
                typeName = forceType;
            } else {
                /** @todo signed vs. unsigned, byte/short/int32/long */
                if (this._isInteger(val)) {
                    if (Math.abs(val) < 0x7FFFFFFF) {
                        typeName = 'int';
                    } else {
                        typeName = 'long';
                    }
                } else {
                    /** @todo float vs. double */
                }
            }
            //debug('Encoding number '+val+' as '+typeName);
            encoder = types.builders[typeName];
            if (!encoder) throw new exceptions.NotImplementedError('encode('+typeName+')');
            return encoder(val, buf);

        case 'object':
            if (val instanceof Array) {
                encoder = types.builders.list;
                return encoder(val, buf, this);
            } else if (val instanceof ForcedType) {
                return this.encode(val.value, buf, val.typeName);
            } else if (val instanceof DescribedType) {
                buf.appendUInt8(0x00);
                this.encode(val.descriptor, buf);
                this.encode(val.value, buf);
                return;
            } else if (val instanceof Int64) {
                encoder = types.builders.long;
                encoder(val, buf, this);
            } else if (val.encodeOrdering && val.encodeOrdering instanceof Array) {
                // Encoding an object's values in a specific ordering as a list.
                var asList = []; // LINQify
                for (var idx in val.encodeOrdering) {
                    asList.push(val[val.encodeOrdering[idx]]);
                }
                return this.encode(asList, buf);
            } else {
                return types.builders.map(val, buf, this);
            }
            break;

        default:
            throw new exceptions.NotImplementedError('encode('+type+')');
    }
};

module.exports = new Codec();