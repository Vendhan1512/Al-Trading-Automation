// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Minimal ERC-20 surface used by the vault.
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @dev HSKSwap SwapRouter02 (Uniswap V3 SwapRouter02 interface, no deadline field).
///      Mainnet 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3 — selector 0xb858183f verified in bytecode.
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev HSKSwap UniswapV3Factory. Mainnet 0x972cA9D1662F5e029cD18327D29026532E84c742.
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @dev Subset of IUniswapV3Pool used for the TWAP floor.
interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}
