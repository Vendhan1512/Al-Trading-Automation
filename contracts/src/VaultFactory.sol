// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CountersignVault} from "./CountersignVault.sol";
import {Clones} from "./libraries/Utils.sol";

/// @title VaultFactory
/// @notice Deploys one CountersignVault per user as an EIP-1167 clone of a shared, verified
///         implementation (~10x cheaper than a full deploy). The caller becomes the vault owner.
contract VaultFactory {
    address public immutable implementation;

    mapping(address => address[]) internal _vaultsOf;
    mapping(address => bool) public isVault;
    address[] public allVaults;

    event VaultCreated(
        address indexed owner, address indexed vault, address agent, address[] guardians, uint8 threshold
    );

    constructor(address implementation_) {
        implementation = implementation_;
    }

    function createVault(
        address agent,
        address[] calldata guardians,
        uint8 threshold,
        address quote,
        address[] calldata assets,
        uint24[] calldata assetFees,
        CountersignVault.Mandate calldata mandate
    ) external returns (address vault) {
        vault = Clones.clone(implementation);
        CountersignVault(vault)
            .initialize(
                CountersignVault.InitParams({
                    owner: msg.sender,
                    agent: agent,
                    guardians: guardians,
                    threshold: threshold,
                    quote: quote,
                    assets: assets,
                    assetFees: assetFees,
                    mandate: mandate
                })
            );
        _vaultsOf[msg.sender].push(vault);
        isVault[vault] = true;
        allVaults.push(vault);
        emit VaultCreated(msg.sender, vault, agent, guardians, threshold);
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
