// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "../../src/libraries/TickMath.sol";
import {FullMath} from "../../src/libraries/FullMath.sol";

library QuoteLib {
    function quoteAtTick(int24 tick, uint256 amountIn, address tokenIn, address tokenOut)
        internal
        pure
        returns (uint256)
    {
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(tick);
        if (sqrtP <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtP) * sqrtP;
            return tokenIn < tokenOut
                ? FullMath.mulDiv(ratioX192, amountIn, 1 << 192)
                : FullMath.mulDiv(1 << 192, amountIn, ratioX192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sqrtP, sqrtP, 1 << 64);
        return tokenIn < tokenOut
            ? FullMath.mulDiv(ratioX128, amountIn, 1 << 128)
            : FullMath.mulDiv(1 << 128, amountIn, ratioX128);
    }
}

/// @dev ERC-20 that also records any transfer out of a watched address to an unexpected
///      recipient (used by the invariant suite).
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public watched;
    mapping(address => bool) public allowedRecipient;
    bool public leaked;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function watch(address w, address[] calldata okRecipients) external {
        watched = w;
        for (uint256 i; i < okRecipients.length; ++i) {
            allowedRecipient[okRecipients[i]] = true;
        }
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (from == watched && watched != address(0) && !allowedRecipient[to]) leaked = true;
    }
}

contract MockPool {
    address public token0;
    address public token1;
    int24 public tick; // price of token0 in token1

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function setTick(int24 t) external {
        tick = t;
    }

    function observe(uint32[] calldata ago) external view returns (int56[] memory tc, uint160[] memory spl) {
        tc = new int56[](2);
        spl = new uint160[](2);
        tc[0] = 0;
        tc[1] = int56(tick) * int56(uint56(ago[0]));
    }
}

contract MockFactory {
    mapping(bytes32 => address) internal pools;

    function key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(t0, t1, fee));
    }

    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[key(a, b, fee)] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[key(a, b, fee)];
    }
}

/// @dev Router that fills at the pool tick price, minus the pool fee, plus a configurable
///      per-pool execution deviation (positive = better than TWAP, negative = worse).
contract MockRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    MockFactory public factory;
    mapping(address => int256) public deviationBps;

    constructor(MockFactory f) {
        factory = f;
    }

    function setDeviation(address pool, int256 bps) external {
        deviationBps[pool] = bps;
    }

    function quoteHop(address tIn, address tOut, uint24 fee, uint256 amountIn) public view returns (uint256) {
        MockPool pool = MockPool(factory.getPool(tIn, tOut, fee));
        require(address(pool) != address(0), "no pool");
        int24 t = pool.tick();
        uint256 out = QuoteLib.quoteAtTick(t, amountIn, tIn, tOut);
        out = out * (1_000_000 - fee) / 1_000_000;
        int256 dev = deviationBps[address(pool)];
        out = uint256(int256(out) * (10_000 + dev) / 10_000);
        return out;
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 amountOut) {
        bytes calldata path = p.path;
        uint256 hops = (path.length - 20) / 23;
        address first = address(bytes20(path[0:20]));
        MockERC20(first).transferFrom(msg.sender, address(this), p.amountIn);
        uint256 amt = p.amountIn;
        address tIn = first;
        for (uint256 i; i < hops; ++i) {
            uint24 fee = uint24(bytes3(path[i * 23 + 20:i * 23 + 23]));
            address tOut = address(bytes20(path[i * 23 + 23:i * 23 + 43]));
            amt = quoteHop(tIn, tOut, fee, amt);
            tIn = tOut;
        }
        require(amt >= p.amountOutMinimum, "Too little received");
        MockERC20(tIn).mint(p.recipient, amt);
        return amt;
    }
}

/// @dev Malicious token-like router used to try reentrancy during a swap.
contract ReentrantRouter {
    address public vault;
    bytes public payload;

    function arm(address v, bytes calldata data) external {
        vault = v;
        payload = data;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata) external payable returns (uint256) {
        (bool ok, bytes memory ret) = vault.call(payload);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return 0;
    }
}
