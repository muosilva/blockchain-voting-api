// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {EllipticCurve} from "./EllipticCurve.sol";

library Secp256k1 {
    uint256 internal constant AA = 0;
    uint256 internal constant BB = 7;
    uint256 internal constant PP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant GX = 55066263022277343669578718895168534326250603453777594175500187360389116729240;
    uint256 internal constant GY = 32670510020758816978083085130507043184471273380659243275938904335757337482424;
    uint256 internal constant NN = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function generator() internal pure returns (uint256, uint256) {
        return (GX, GY);
    }

    function order() internal pure returns (uint256) {
        return NN;
    }

    function add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal pure returns (uint256, uint256) {
        (uint256 rx, uint256 ry, uint256 rz) = EllipticCurve.jacAdd(x1, y1, 1, x2, y2, 1, PP);
        return EllipticCurve.toAffine(rx, ry, rz, PP);
    }

    function multiply(uint256 scalar, uint256 x, uint256 y) internal pure returns (uint256, uint256) {
        (uint256 rx, uint256 ry, uint256 rz) = EllipticCurve.jacMul(scalar, x, y, 1, AA, PP);
        return EllipticCurve.toAffine(rx, ry, rz, PP);
    }

    function mulG(uint256 scalar) internal pure returns (uint256, uint256) {
        (uint256 gx, uint256 gy) = generator();
        return multiply(scalar, gx, gy);
    }
}
