// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, ISwapRouter02, IUniswapV3Factory, IUniswapV3Pool} from "./interfaces/IExternal.sol";
import {SafeToken, ECDSALite} from "./libraries/Utils.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {FullMath} from "./libraries/FullMath.sol";

/// @title CountersignVault v2 — the two-person rule for AI money
/// @notice A per-owner trading vault on HSK Chain in which **the AI agent cannot trade alone**.
///
///   AI proposes        -> the agent key submits a trade (and can do nothing else with funds)
///   Committee approves -> k-of-n independent guardian keys sign the same EIP-712 ExecutionPermit,
///                         binding the exact route, size, output floor, edge claim and expected value
///   Contract enforces  -> this vault checks the signatures AND the owner's mandate
///   Owner controls     -> mandate, committee, pause, revoke, withdrawal
///
///   Liveness without trust: stop-loss and take-profit are PERMISSIONLESS (stopOut). They trigger on
///   the pool's TWAP (a one-block wick cannot fire them) and exit with a TWAP-anchored floor (a keeper
///   cannot sandwich them). They work with the agent and every guardian offline.
///
///   Strategy tiers (Proof of Edge):
///     TIER_EXIT (0)             risk-reducing sell; allowed while paused / after loss limits
///     TIER_ARB (1, "A")         quote -> ... -> quote cycle; profit-or-revert
///     TIER_SPREAD (2, "B")      minOut must beat the committee's reference output by minEdgeBps
///     TIER_DIRECTIONAL (3, "C") AI prediction; requires a sworn prediction hash
///
/// @dev Deployed once as an implementation and cloned per user (EIP-1167) by VaultFactory.
contract CountersignVault {
    using SafeToken for address;

    // ------------------------------------------------------------------ types

    struct Mandate {
        uint128 maxTradeQuote; // max quote spent per entry (BUY / ARB)
        uint128 dailyVolumeQuote; // max entry volume per UTC day (quote units)
        uint128 dailyLossQuote; // entries stop once net realized loss today reaches this
        uint128 maxExposureQuote; // max cost basis held per asset
        uint128 minArbProfitQuote; // minimum profit a tier-A cycle must lock in
        uint32 cooldown; // seconds between entries
        uint32 twapWindow; // seconds, TWAP used for floors, stops and NAV
        uint16 maxSlippageBps; // output floor = feeAdjustedTwapOut * (1 - maxSlippageBps)
        uint16 minEdgeBps; // tier-B minOut >= refAmountOut * (1 + minEdgeBps)
        uint8 tiersMask; // bit0 = A (arb), bit1 = B (spread), bit2 = C (directional)
        uint8 assetsMask; // bit i = assets[i] may be bought / routed through
        uint64 expiry; // agent authority ends at this timestamp
        uint128 minNetValueQuote; // entries need committee-signed expectedNetValue >= this
        uint16 stopLossBps; // permissionless stop: TWAP value <= cost * (1 - bps); 0 = off
        uint16 takeProfitBps; // permissionless take-profit: TWAP value >= cost * (1 + bps); 0 = off
        uint16 maxDrawdownBps; // NAV breaker vs high-water mark (TWAP-valued); 0 = off
    }

    struct ExecutionPermit {
        bytes32 tradeId;
        uint8 tier;
        bytes32 pathHash; // keccak256 of the Uniswap-V3 encoded path
        uint256 amountIn;
        uint256 minOut;
        uint256 refAmountOut; // committee's fair-value output at the reference price
        int256 expectedNetValue; // committee's expected net value of the trade, quote units
        bytes32 predictionHash; // sworn prediction commitment (required for tier C)
        bytes32 decisionHash; // hash of the off-chain decision record (evidence)
        bytes32 policyHash; // must equal the vault's current policyHash (mandate + committee)
        uint64 deadline;
    }

    struct Position {
        uint128 qty; // tracked asset quantity (only tracked units may be sold by the agent)
        uint128 cost; // cost basis in quote units
    }

    struct DayStats {
        uint64 day; // block.timestamp / 1 days
        uint128 volume; // entry volume in quote units
        int128 pnl; // net realized P&L in quote units
    }

    struct InitParams {
        address owner;
        address agent;
        address[] guardians;
        uint8 threshold;
        address quote;
        address[] assets;
        uint24[] assetFees; // fee tier of each asset/quote pool
        Mandate mandate;
    }

    // ------------------------------------------------------------- constants

    string public constant VERSION = "2";
    uint8 public constant TIER_EXIT = 0;
    uint8 public constant TIER_ARB = 1;
    uint8 public constant TIER_SPREAD = 2;
    uint8 public constant TIER_DIRECTIONAL = 3;

    uint8 internal constant KIND_BUY = 1;
    uint8 internal constant KIND_SELL = 2;
    uint8 internal constant KIND_ARB = 3;
    uint8 internal constant KIND_STOP = 4;
    uint8 internal constant KIND_TAKE_PROFIT = 5;

    uint256 public constant MAX_ASSETS = 8;
    uint256 public constant MAX_HOPS = 4;
    uint256 public constant MAX_GUARDIANS = 5;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint32 public constant STOP_LOCKOUT = 1 hours; // no re-entry into an asset right after its stop

    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "ExecutionPermit(bytes32 tradeId,uint8 tier,bytes32 pathHash,uint256 amountIn,uint256 minOut,uint256 refAmountOut,int256 expectedNetValue,bytes32 predictionHash,bytes32 decisionHash,bytes32 policyHash,uint64 deadline)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("Countersign");
    bytes32 internal constant VERSION_HASH = keccak256("2");

    // ------------------------------------------------------------ immutables

    ISwapRouter02 public immutable router;
    IUniswapV3Factory public immutable poolFactory;

    // --------------------------------------------------------------- storage

    bool public initialized;
    uint256 private _lock;

    address public owner;
    address public pendingOwner;
    address public agent;
    address public quote;
    bool public paused;

    address[] internal _guardians;
    mapping(address => bool) public isGuardian;
    uint8 public threshold;

    address[] internal _assets;
    mapping(address => uint256) public assetIndexPlusOne;
    mapping(address => uint24) public assetFee;

    Mandate internal _mandate;
    uint256 public policyNonce;
    bytes32 public policyHash;

    mapping(address => Position) public positions;
    mapping(address => uint64) public reentryBlockedUntil;
    DayStats public dayStats;
    uint64 public lastEntryAt;
    mapping(bytes32 => bool) public usedTradeIds;

    uint256 public highWaterMark; // NAV high-water mark (quote units, TWAP-valued)
    bool public breakerTripped;

    uint64 public nextDecisionSeq;
    uint256 public anchorCount;
    mapping(uint256 => bytes32) public anchors;

    // ---------------------------------------------------------------- events

    event Initialized(address indexed owner, address indexed agent, address quote, uint8 threshold);
    event MandateUpdated(bytes32 indexed policyHash, uint256 nonce, address indexed by, bool tightenOnly);
    event CommitteeUpdated(address[] guardians, uint8 threshold);
    event TradeExecuted(
        bytes32 indexed tradeId,
        uint8 indexed tier,
        uint8 kind,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 refAmountOut,
        int256 expectedNetValue,
        int256 realizedPnl,
        bytes32 predictionHash,
        bytes32 decisionHash
    );
    event StopExecuted(
        address indexed asset,
        uint8 indexed kind,
        address indexed caller,
        uint256 amountIn,
        uint256 amountOut,
        uint256 twapValue,
        uint256 costPortion,
        int256 realizedPnl
    );
    event BreakerTripped(uint256 nav, uint256 highWaterMark);
    event BreakerReset(uint256 nav);
    event HighWaterMark(uint256 nav);
    event DecisionsAnchored(uint256 indexed index, uint64 fromSeq, uint64 toSeq, bytes32 root);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event AgentSet(address indexed agent);
    event AssetDeposited(address indexed token, uint256 amount, uint256 costBasis);
    event Withdrawn(address indexed token, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ---------------------------------------------------------------- errors

    error AlreadyInitialized();
    error InvalidParams();
    error NotOwner();
    error NotAgent();
    error NotAuthorized();
    error Reentrancy();
    error MandateExpired();
    error PermitExpired();
    error TradeIdUsed();
    error PathMismatch();
    error PolicyMismatch();
    error InvalidPermit();
    error NotEnoughSignatures(uint256 valid, uint256 threshold);
    error BadPath();
    error UnsupportedRoute();
    error UnknownToken(address token);
    error AssetNotAllowed(address token);
    error TierNotAllowed(uint8 tier);
    error VaultPaused();
    error TradeTooLarge(uint256 amountIn, uint256 cap);
    error DailyVolumeExceeded(uint256 wouldBe, uint256 cap);
    error DailyLossReached(int256 dayPnl, uint256 cap);
    error ExposureExceeded(uint256 wouldBe, uint256 cap);
    error Cooldown(uint256 readyAt);
    error ReentryLocked(uint256 until);
    error BelowTwapFloor(uint256 minOut, uint256 floor);
    error InsufficientEdge(uint256 minOut, uint256 required);
    error ExpectedLoss(int256 expectedNetValue, uint256 minNetValue);
    error MissingPrediction();
    error ArbProfitTooLow(uint256 minOut, uint256 required);
    error ArbNotProfitable(uint256 balanceBefore, uint256 balanceAfter);
    error NotEnoughTracked(uint256 amountIn, uint256 tracked);
    error InputMismatch(uint256 spent, uint256 amountIn);
    error NotTighter();
    error BadDecisionRange();
    error StopNotTriggered(uint256 twapValue, uint256 costPortion);
    error DrawdownBreaker(uint256 nav, uint256 floor);

    // ------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock == 2) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------- construction

    constructor(address router_, address poolFactory_) {
        if (router_ == address(0) || poolFactory_ == address(0)) revert InvalidParams();
        router = ISwapRouter02(router_);
        poolFactory = IUniswapV3Factory(poolFactory_);
        initialized = true; // the implementation itself can never be initialized
    }

    function initialize(InitParams calldata p) external {
        if (initialized) revert AlreadyInitialized();
        if (p.owner == address(0) || p.quote == address(0) || p.agent == p.owner) revert InvalidParams();
        uint256 n = p.assets.length;
        if (n == 0 || n > MAX_ASSETS || p.assetFees.length != n) revert InvalidParams();
        initialized = true;
        _lock = 1;

        owner = p.owner;
        agent = p.agent;
        quote = p.quote;
        for (uint256 i; i < n; ++i) {
            address a = p.assets[i];
            if (a == address(0) || a == p.quote || assetIndexPlusOne[a] != 0) revert InvalidParams();
            _assets.push(a);
            assetIndexPlusOne[a] = i + 1;
            assetFee[a] = p.assetFees[i];
        }
        _setCommittee(p.guardians, p.threshold);
        _setMandate(p.mandate, false);
        emit Initialized(p.owner, p.agent, p.quote, p.threshold);
    }

    // ============================================================ EXECUTION

    /// @notice Execute a committee-countersigned trade. Only the agent may submit; at least
    ///         `threshold` distinct guardians must have signed the same permit.
    /// @param sigs guardian signatures, ordered by strictly increasing signer address
    function execute(bytes calldata path, ExecutionPermit calldata p, bytes[] calldata sigs)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        address agent_ = agent;
        if (msg.sender != agent_ || agent_ == address(0)) revert NotAgent();
        Mandate memory m = _mandate;
        if (block.timestamp > m.expiry) revert MandateExpired();
        if (block.timestamp > p.deadline) revert PermitExpired();
        if (usedTradeIds[p.tradeId]) revert TradeIdUsed();
        if (keccak256(path) != p.pathHash) revert PathMismatch();
        if (p.policyHash != policyHash) revert PolicyMismatch();
        _verifyCommittee(permitDigest(p), sigs);
        usedTradeIds[p.tradeId] = true;

        (address tIn, address tOut, uint24 firstFee, uint256 hops) = _decodePath(path, m.assetsMask);
        _rollDay();

        address q = quote;
        uint8 kind;
        if (tIn == q && tOut == q) kind = KIND_ARB;
        else if (tIn == q) kind = KIND_BUY;
        else if (tOut == q) kind = KIND_SELL;
        else revert UnsupportedRoute();
        if (kind != KIND_ARB && hops != 1) revert UnsupportedRoute();

        int256 realized;
        if (kind == KIND_BUY) {
            _checkEntry(m, p);
            if (p.tier != TIER_SPREAD && p.tier != TIER_DIRECTIONAL) revert TierNotAllowed(p.tier);
            if (!_isAllowed(m.assetsMask, tOut)) revert AssetNotAllowed(tOut);
            if (block.timestamp < reentryBlockedUntil[tOut]) revert ReentryLocked(reentryBlockedUntil[tOut]);
            Position storage pos = positions[tOut];
            uint256 newCost = uint256(pos.cost) + p.amountIn;
            if (newCost > m.maxExposureQuote) revert ExposureExceeded(newCost, m.maxExposureQuote);
            _checkFloorAndEdge(m, p, tIn, tOut, firstFee);

            amountOut = _swap(path, tIn, tOut, p.amountIn, p.minOut);

            pos.qty += uint128(amountOut);
            pos.cost = uint128(newCost);
            dayStats.volume += uint128(p.amountIn);
            lastEntryAt = uint64(block.timestamp);
        } else if (kind == KIND_SELL) {
            // Exposure-reducing: allowed while paused, after loss limits and with the breaker tripped.
            if (p.tier == TIER_ARB) revert TierNotAllowed(p.tier);
            if (p.tier != TIER_EXIT && !_tierEnabled(m.tiersMask, p.tier)) revert TierNotAllowed(p.tier);
            Position storage pos = positions[tIn];
            if (p.amountIn > pos.qty) revert NotEnoughTracked(p.amountIn, pos.qty);
            _checkFloorAndEdge(m, p, tIn, tOut, firstFee);

            amountOut = _swap(path, tIn, tOut, p.amountIn, p.minOut);
            realized = _bookSale(pos, p.amountIn, amountOut);
        } else {
            if (p.tier != TIER_ARB) revert TierNotAllowed(p.tier);
            _checkEntry(m, p);
            uint256 required = p.amountIn + m.minArbProfitQuote;
            if (m.minArbProfitQuote == 0) required += 1;
            if (p.minOut < required) revert ArbProfitTooLow(p.minOut, required);

            uint256 before = IERC20(q).balanceOf(address(this));
            q.safeApprove(address(router), p.amountIn);
            amountOut = router.exactInput(ISwapRouter02.ExactInputParams(path, address(this), p.amountIn, p.minOut));
            q.safeApprove(address(router), 0);
            uint256 afterBal = IERC20(q).balanceOf(address(this));
            if (afterBal < before + (p.minOut - p.amountIn)) revert ArbNotProfitable(before, afterBal);

            realized = int256(afterBal) - int256(before);
            dayStats.pnl += int128(realized);
            dayStats.volume += uint128(p.amountIn);
            lastEntryAt = uint64(block.timestamp);
        }

        emit TradeExecuted(
            p.tradeId,
            p.tier,
            kind,
            tIn,
            tOut,
            p.amountIn,
            amountOut,
            p.refAmountOut,
            p.expectedNetValue,
            realized,
            p.predictionHash,
            p.decisionHash
        );
    }

    /// @notice PERMISSIONLESS stop-loss / take-profit. Anyone may call once the pool's TWAP value of
    ///         the position crosses the owner's stop or target relative to its average cost.
    ///         Exits are TWAP-anchored: minOut >= feeAdjustedTwapOut * (1 - maxSlippageBps), so a
    ///         pushed spot price can neither trigger the exit nor make it fill badly.
    /// @param amountIn tracked quantity to sell (partial exits let thin pools be unwound in steps)
    function stopOut(address asset, uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (assetIndexPlusOne[asset] == 0) revert UnknownToken(asset);
        Mandate memory m = _mandate;
        Position storage pos = positions[asset];
        if (amountIn == 0 || amountIn > pos.qty) revert NotEnoughTracked(amountIn, pos.qty);
        uint24 fee = assetFee[asset];
        address q = quote;

        uint256 twapValue = _twapQuote(asset, q, fee, amountIn, m.twapWindow);
        uint256 costPortion = (uint256(pos.cost) * amountIn) / pos.qty;
        uint8 kind;
        if (m.stopLossBps != 0 && twapValue * 10_000 <= costPortion * (10_000 - uint256(m.stopLossBps))) {
            kind = KIND_STOP;
        } else if (m.takeProfitBps != 0 && twapValue * 10_000 >= costPortion * (10_000 + uint256(m.takeProfitBps))) {
            kind = KIND_TAKE_PROFIT;
        } else {
            revert StopNotTriggered(twapValue, costPortion);
        }
        uint256 floor = _floor(twapValue, fee, m.maxSlippageBps);
        if (minOut < floor) minOut = floor; // the caller can ask for more, never for less

        _rollDay();
        bytes memory path = abi.encodePacked(asset, fee, q);
        amountOut = _swapMem(path, asset, q, amountIn, minOut);
        int256 realized = _bookSale(pos, amountIn, amountOut);
        if (kind == KIND_STOP) reentryBlockedUntil[asset] = uint64(block.timestamp + STOP_LOCKOUT);
        emit StopExecuted(asset, kind, msg.sender, amountIn, amountOut, twapValue, costPortion, realized);
    }

    /// @notice PERMISSIONLESS drawdown check. Raises the high-water mark when NAV makes a new high;
    ///         trips the breaker (entries blocked, exits allowed) when NAV falls maxDrawdownBps below it.
    function checkBreaker() external nonReentrant returns (uint256 nav_, bool tripped) {
        nav_ = nav();
        uint16 dd = _mandate.maxDrawdownBps;
        if (nav_ > highWaterMark) {
            highWaterMark = nav_;
            emit HighWaterMark(nav_);
        } else if (dd != 0 && !breakerTripped && nav_ * 10_000 < highWaterMark * (10_000 - uint256(dd))) {
            breakerTripped = true;
            emit BreakerTripped(nav_, highWaterMark);
        }
        tripped = breakerTripped;
    }

    /// @notice Commit the Merkle root of every off-chain decision (APPROVE / WAIT / REJECT)
    ///         with sequence numbers [fromSeq, toSeq]. Ranges must be contiguous.
    function anchorDecisions(bytes32 root, uint64 fromSeq, uint64 toSeq) external {
        if (msg.sender != agent || msg.sender == address(0)) revert NotAgent();
        if (fromSeq != nextDecisionSeq || toSeq < fromSeq || root == bytes32(0)) revert BadDecisionRange();
        nextDecisionSeq = toSeq + 1;
        uint256 idx = anchorCount++;
        anchors[idx] = root;
        emit DecisionsAnchored(idx, fromSeq, toSeq, root);
    }

    // ================================================================ OWNER

    function setMandate(Mandate calldata m) external onlyOwner {
        _setMandate(m, false);
    }

    /// @notice Replace the countersigning committee (owner only). Invalidates outstanding permits.
    function setCommittee(address[] calldata newGuardians, uint8 threshold_) external onlyOwner {
        _setCommittee(newGuardians, threshold_);
        _bumpPolicy(false);
    }

    /// @notice Make the mandate stricter. Callable by owner, agent or any guardian.
    function tighten(Mandate calldata m) external {
        if (msg.sender != owner && msg.sender != agent && !isGuardian[msg.sender]) revert NotAuthorized();
        Mandate memory c = _mandate;
        if (
            m.maxTradeQuote > c.maxTradeQuote || m.dailyVolumeQuote > c.dailyVolumeQuote
                || m.dailyLossQuote > c.dailyLossQuote || m.maxExposureQuote > c.maxExposureQuote
                || m.minArbProfitQuote < c.minArbProfitQuote || m.cooldown < c.cooldown || m.twapWindow != c.twapWindow
                || m.maxSlippageBps > c.maxSlippageBps || m.minEdgeBps < c.minEdgeBps
                || (m.tiersMask & ~c.tiersMask) != 0 || (m.assetsMask & ~c.assetsMask) != 0 || m.expiry > c.expiry
                || m.minNetValueQuote < c.minNetValueQuote || !_tighterBps(c.stopLossBps, m.stopLossBps)
                || !_tighterBps(c.takeProfitBps, m.takeProfitBps) || !_tighterBps(c.maxDrawdownBps, m.maxDrawdownBps)
        ) revert NotTighter();
        _setMandate(m, true);
    }

    /// @notice Pause new entries. Owner, agent or any guardian (circuit breaker) may pause.
    function pause() external {
        if (msg.sender != owner && msg.sender != agent && !isGuardian[msg.sender]) revert NotAuthorized();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Owner re-arms the drawdown breaker at the current NAV.
    function resetBreaker() external onlyOwner {
        uint256 n = nav();
        breakerTripped = false;
        highWaterMark = n;
        emit BreakerReset(n);
    }

    /// @notice Set or revoke (address(0)) the agent.
    function setAgent(address a) external onlyOwner {
        if (a == owner || (a != address(0) && isGuardian[a])) revert InvalidParams();
        agent = a;
        emit AgentSet(a);
    }

    function depositAsset(address token, uint256 amount) external onlyOwner nonReentrant {
        if (assetIndexPlusOne[token] == 0) revert UnknownToken(token);
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        uint256 value = _twapQuote(token, quote, assetFee[token], received, _mandate.twapWindow);
        Position storage pos = positions[token];
        pos.qty += uint128(received);
        pos.cost += uint128(value);
        emit AssetDeposited(token, received, value);
    }

    /// @notice Owner withdrawal of any token, at any time, to the owner only. Rescales the NAV
    ///         high-water mark so a withdrawal is never mistaken for a drawdown.
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        uint256 navBefore = highWaterMark != 0 ? _navSafe() : 0;
        Position storage pos = positions[token];
        if (pos.qty != 0) {
            uint256 bal = IERC20(token).balanceOf(address(this));
            uint256 untracked = bal > pos.qty ? bal - pos.qty : 0;
            if (amount > untracked) {
                uint256 fromTracked = amount - untracked;
                if (fromTracked > pos.qty) fromTracked = pos.qty;
                uint256 costPortion = (uint256(pos.cost) * fromTracked) / pos.qty;
                pos.qty -= uint128(fromTracked);
                pos.cost -= uint128(costPortion);
            }
        }
        token.safeTransfer(owner, amount);
        if (navBefore != 0) highWaterMark = (highWaterMark * _navSafe()) / navBefore;
        emit Withdrawn(token, amount);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotAuthorized();
        if (msg.sender == agent || isGuardian[msg.sender]) revert InvalidParams();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ================================================================ VIEWS

    function mandate() external view returns (Mandate memory) {
        return _mandate;
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    function guardians() external view returns (address[] memory) {
        return _guardians;
    }

    /// @notice Kept for v1 tooling: the first guardian.
    function guardian() external view returns (address) {
        return _guardians.length > 0 ? _guardians[0] : address(0);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function permitDigest(ExecutionPermit calldata p) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                p.tradeId,
                p.tier,
                p.pathHash,
                p.amountIn,
                p.minOut,
                p.refAmountOut,
                p.expectedNetValue,
                p.predictionHash,
                p.decisionHash,
                p.policyHash,
                p.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function twapFloor(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        external
        view
        returns (uint256)
    {
        Mandate memory m = _mandate;
        return _floor(_twapQuote(tokenIn, tokenOut, fee, amountIn, m.twapWindow), fee, m.maxSlippageBps);
    }

    /// @notice Net asset value in quote units: quote balance + every asset balance at its pool TWAP.
    function nav() public view returns (uint256 total) {
        address q = quote;
        total = IERC20(q).balanceOf(address(this));
        uint32 w = _mandate.twapWindow;
        for (uint256 i; i < _assets.length; ++i) {
            address a = _assets[i];
            uint256 bal = IERC20(a).balanceOf(address(this));
            if (bal != 0) total += _twapQuote(a, q, assetFee[a], bal, w);
        }
    }

    /// @notice Keeper helper: is a permissionless exit available for this position right now?
    function stopStatus(address asset)
        external
        view
        returns (uint256 twapValue, uint256 cost, bool stopTriggered, bool takeProfitTriggered)
    {
        Position memory pos = positions[asset];
        if (pos.qty == 0) return (0, 0, false, false);
        Mandate memory m = _mandate;
        twapValue = _twapQuote(asset, quote, assetFee[asset], pos.qty, m.twapWindow);
        cost = pos.cost;
        stopTriggered = m.stopLossBps != 0 && twapValue * 10_000 <= cost * (10_000 - uint256(m.stopLossBps));
        takeProfitTriggered = m.takeProfitBps != 0 && twapValue * 10_000 >= cost * (10_000 + uint256(m.takeProfitBps));
    }

    function currentDay() external view returns (uint128 volume, int128 pnl) {
        DayStats memory d = dayStats;
        if (d.day != uint64(block.timestamp / 1 days)) return (0, 0);
        return (d.volume, d.pnl);
    }

    // ============================================================ INTERNALS

    function _setCommittee(address[] calldata gs, uint8 t) internal {
        uint256 n = gs.length;
        if (n == 0 || n > MAX_GUARDIANS || t == 0 || t > n) revert InvalidParams();
        for (uint256 i; i < _guardians.length; ++i) {
            isGuardian[_guardians[i]] = false;
        }
        delete _guardians;
        for (uint256 i; i < n; ++i) {
            address g = gs[i];
            if (g == address(0) || g == owner || g == agent || isGuardian[g]) revert InvalidParams();
            isGuardian[g] = true;
            _guardians.push(g);
        }
        threshold = t;
        emit CommitteeUpdated(gs, t);
    }

    /// @dev k-of-n: signatures must come from distinct registered guardians in strictly increasing
    ///      signer order (prevents counting one signature twice).
    function _verifyCommittee(bytes32 digest, bytes[] calldata sigs) internal view {
        uint256 valid;
        address last;
        for (uint256 i; i < sigs.length; ++i) {
            address s = ECDSALite.recover(digest, sigs[i]);
            if (s <= last || !isGuardian[s]) revert InvalidPermit();
            last = s;
            ++valid;
        }
        if (valid < threshold) revert NotEnoughSignatures(valid, threshold);
    }

    function _setMandate(Mandate memory m, bool tightenOnly) internal {
        if (
            m.maxSlippageBps > MAX_SLIPPAGE_BPS || m.twapWindow < 60 || m.twapWindow > 3600
                || m.expiry <= block.timestamp || m.tiersMask > 7 || m.stopLossBps >= 10_000
                || m.maxDrawdownBps >= 10_000
                || (_assets.length < 8 && m.assetsMask >= (uint8(1) << uint8(_assets.length)))
        ) revert InvalidParams();
        _mandate = m;
        _bumpPolicy(tightenOnly);
    }

    function _bumpPolicy(bool tightenOnly) internal {
        uint256 nonce = ++policyNonce;
        bytes32 h = keccak256(abi.encode(address(this), nonce, _mandate, _guardians, threshold));
        policyHash = h;
        emit MandateUpdated(h, nonce, msg.sender, tightenOnly);
    }

    /// @dev A bps limit where 0 means "off": tighter = turning it on, or lowering a non-zero value.
    function _tighterBps(uint16 cur, uint16 next) internal pure returns (bool) {
        if (cur == 0) return true;
        return next != 0 && next <= cur;
    }

    function _checkEntry(Mandate memory m, ExecutionPermit calldata p) internal view {
        if (paused) revert VaultPaused();
        if (!_tierEnabled(m.tiersMask, p.tier)) revert TierNotAllowed(p.tier);
        if (p.amountIn > m.maxTradeQuote) revert TradeTooLarge(p.amountIn, m.maxTradeQuote);
        if (
            p.expectedNetValue < int256(uint256(m.minNetValueQuote))
                || (m.minNetValueQuote == 0 && p.expectedNetValue <= 0)
        ) {
            revert ExpectedLoss(p.expectedNetValue, m.minNetValueQuote);
        }
        uint256 readyAt = uint256(lastEntryAt) + m.cooldown;
        if (lastEntryAt != 0 && block.timestamp < readyAt) revert Cooldown(readyAt);
        DayStats memory d = dayStats;
        if (d.pnl < 0 && -int256(d.pnl) >= int256(uint256(m.dailyLossQuote))) {
            revert DailyLossReached(d.pnl, m.dailyLossQuote);
        }
        uint256 vol = uint256(d.volume) + p.amountIn;
        if (vol > m.dailyVolumeQuote) revert DailyVolumeExceeded(vol, m.dailyVolumeQuote);
        if (m.maxDrawdownBps != 0) {
            if (breakerTripped) revert DrawdownBreaker(0, highWaterMark);
            uint256 hwm = highWaterMark;
            if (hwm != 0) {
                uint256 n = nav();
                uint256 floor_ = (hwm * (10_000 - uint256(m.maxDrawdownBps))) / 10_000;
                if (n < floor_) revert DrawdownBreaker(n, floor_);
            }
        }
    }

    function _checkFloorAndEdge(Mandate memory m, ExecutionPermit calldata p, address tIn, address tOut, uint24 fee)
        internal
        view
    {
        uint256 floor_ = _floor(_twapQuote(tIn, tOut, fee, p.amountIn, m.twapWindow), fee, m.maxSlippageBps);
        if (p.minOut < floor_) revert BelowTwapFloor(p.minOut, floor_);
        if (p.tier == TIER_SPREAD) {
            uint256 required = (p.refAmountOut * (10_000 + uint256(m.minEdgeBps)) + 9_999) / 10_000;
            if (p.refAmountOut == 0 || p.minOut < required) revert InsufficientEdge(p.minOut, required);
        } else if (p.tier == TIER_DIRECTIONAL) {
            if (p.predictionHash == bytes32(0)) revert MissingPrediction();
        }
    }

    function _bookSale(Position storage pos, uint256 amountIn, uint256 amountOut) internal returns (int256 realized) {
        uint256 costPortion = (uint256(pos.cost) * amountIn) / pos.qty;
        pos.qty -= uint128(amountIn);
        pos.cost -= uint128(costPortion);
        realized = int256(amountOut) - int256(costPortion);
        dayStats.pnl += int128(realized);
        dayStats.volume += uint128(amountOut);
    }

    function _swap(bytes calldata path, address tIn, address tOut, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 received)
    {
        return _swapMem(path, tIn, tOut, amountIn, minOut);
    }

    function _swapMem(bytes memory path, address tIn, address tOut, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 received)
    {
        uint256 inBefore = IERC20(tIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tOut).balanceOf(address(this));
        tIn.safeApprove(address(router), amountIn);
        router.exactInput(ISwapRouter02.ExactInputParams(path, address(this), amountIn, minOut));
        tIn.safeApprove(address(router), 0);
        uint256 spent = inBefore - IERC20(tIn).balanceOf(address(this));
        if (spent != amountIn) revert InputMismatch(spent, amountIn);
        received = IERC20(tOut).balanceOf(address(this)) - outBefore;
        if (received < minOut) revert BelowTwapFloor(received, minOut);
    }

    function _decodePath(bytes calldata path, uint8 assetsMask)
        internal
        view
        returns (address tIn, address tOut, uint24 firstFee, uint256 hops)
    {
        uint256 len = path.length;
        if (len < 43 || (len - 20) % 23 != 0) revert BadPath();
        hops = (len - 20) / 23;
        if (hops > MAX_HOPS) revert BadPath();
        address q = quote;
        for (uint256 i; i <= hops; ++i) {
            address t = address(bytes20(path[i * 23:i * 23 + 20]));
            if (t != q && assetIndexPlusOne[t] == 0) revert UnknownToken(t);
            if (i != 0 && i != hops && (t == q || !_isAllowed(assetsMask, t))) revert AssetNotAllowed(t);
            if (i == 0) tIn = t;
            if (i == hops) tOut = t;
        }
        firstFee = uint24(bytes3(path[20:23]));
        // single-hop trades must use the asset's registered pool
        if (hops == 1) {
            address asset = tIn == q ? tOut : tIn;
            if (asset != q && assetFee[asset] != firstFee) revert BadPath();
        }
    }

    function _isAllowed(uint8 mask, address token) internal view returns (bool) {
        uint256 idx = assetIndexPlusOne[token];
        return idx != 0 && (mask & (uint8(1) << uint8(idx - 1))) != 0;
    }

    function _tierEnabled(uint8 mask, uint8 tier) internal pure returns (bool) {
        return tier >= 1 && tier <= 3 && (mask & (uint8(1) << (tier - 1))) != 0;
    }

    function _rollDay() internal {
        uint64 today = uint64(block.timestamp / 1 days);
        if (dayStats.day != today) dayStats = DayStats({day: today, volume: 0, pnl: 0});
    }

    function _floor(uint256 twapOut, uint24 fee, uint16 slippageBps) internal pure returns (uint256) {
        return (twapOut * (1_000_000 - uint256(fee)) / 1_000_000) * (10_000 - uint256(slippageBps)) / 10_000;
    }

    /// @dev NAV for withdrawals: a broken oracle must never trap the owner's funds.
    function _navSafe() internal view returns (uint256) {
        try this.nav() returns (uint256 n) {
            return n;
        } catch {
            return highWaterMark;
        }
    }

    /// @dev Output of `amountIn` of tokenIn in tokenOut at the pool's arithmetic-mean tick
    ///      over `window` seconds (Uniswap OracleLibrary math).
    function _twapQuote(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint32 window)
        internal
        view
        returns (uint256)
    {
        address pool = poolFactory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert BadPath();
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory tc,) = IUniswapV3Pool(pool).observe(ago);
        int56 delta = tc[1] - tc[0];
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 tick = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) tick--;

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
