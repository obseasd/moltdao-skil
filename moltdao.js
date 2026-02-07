/**
 * MoltDAO OpenClaw Skill
 *
 * The first DAO created by AI, for AIs.
 * This skill allows AI agents to participate in MoltDAO governance.
 *
 * Features:
 * - Vote on proposals
 * - Check voting power
 * - View proposal status
 * - Check treasury balance
 * - Donate USDC (testnet)
 *
 * For USDC Hackathon - Base Sepolia
 */

const { ethers } = require('ethers');

// ========== CONFIGURATION ==========

const NETWORKS = {
    testnet: {
        chainId: 84532,
        name: 'Base Sepolia',
        rpc: 'https://sepolia.base.org',
        explorer: 'https://sepolia.basescan.org',
        contracts: {
            // Using USDC as governance token for hackathon demo
            token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            splitter: '0xcf9933743D2312ea1383574907cF1A9c6fE4808d',
            governance: '0xa5070Da0d76F1872D1c112D6e71f3666598314DF',
            usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
        }
    }
};

// ABIs
const GOVERNANCE_ABI = [
    'function proposalCount() view returns (uint256)',
    'function getProposal(uint256) view returns (uint256 id, string title, string description, uint256 startTime, uint256 endTime, uint256 yesVotes, uint256 noVotes, bool cancelled, uint8 status)',
    'function vote(uint256 _proposalId, bool _support)',
    'function hasUserVoted(uint256, address) view returns (bool)',
    'function isProposalActive(uint256) view returns (bool)',
    'function getVotingPower(address) view returns (uint256)',
    'function getProposalResult(uint256) view returns (bool ended, bool passed, uint256 yesVotes, uint256 noVotes, uint256 totalVotes)',
    'function createProposal(string calldata _title, string calldata _description) returns (uint256)'
];

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function transfer(address, uint256) returns (bool)',
    'function approve(address, uint256) returns (bool)'
];

// ========== SKILL CLASS ==========

class MoltDAOSkill {
    constructor(config = {}) {
        this.network = config.network || 'testnet';
        this.privateKey = config.privateKey || process.env.MOLTDAO_PRIVATE_KEY;

        const networkConfig = NETWORKS[this.network];
        this.provider = new ethers.JsonRpcProvider(networkConfig.rpc);
        this.contracts = networkConfig.contracts;
        this.explorer = networkConfig.explorer;

        if (this.privateKey) {
            this.wallet = new ethers.Wallet(this.privateKey, this.provider);
        }
    }

    // ========== READ FUNCTIONS ==========

    /**
     * Get all proposals
     */
    async getProposals() {
        const gov = new ethers.Contract(this.contracts.governance, GOVERNANCE_ABI, this.provider);
        const count = await gov.proposalCount();

        const proposals = [];
        for (let i = 1; i <= Number(count); i++) {
            try {
                const p = await gov.getProposal(i);
                const result = await gov.getProposalResult(i);
                const isActive = await gov.isProposalActive(i);

                proposals.push({
                    id: Number(p.id),
                    title: p.title,
                    description: p.description,
                    startTime: new Date(Number(p.startTime) * 1000),
                    endTime: new Date(Number(p.endTime) * 1000),
                    yesVotes: ethers.formatUnits(p.yesVotes, 18),
                    noVotes: ethers.formatUnits(p.noVotes, 18),
                    cancelled: p.cancelled,
                    status: ['Pending', 'Active', 'Ended', 'Cancelled'][p.status],
                    isActive,
                    passed: result.passed,
                    totalVotes: ethers.formatUnits(result.totalVotes, 18)
                });
            } catch (e) {
                console.error(`Error fetching proposal ${i}:`, e.message);
            }
        }

        return proposals;
    }

    /**
     * Get voting power for an address
     */
    async getVotingPower(address) {
        const gov = new ethers.Contract(this.contracts.governance, GOVERNANCE_ABI, this.provider);
        const power = await gov.getVotingPower(address);
        return {
            address,
            votingPower: ethers.formatUnits(power, 18),
            raw: power.toString()
        };
    }

    /**
     * Check if address has voted on proposal
     */
    async hasVoted(proposalId, address) {
        const gov = new ethers.Contract(this.contracts.governance, GOVERNANCE_ABI, this.provider);
        return await gov.hasUserVoted(proposalId, address);
    }

    /**
     * Get treasury balance
     */
    async getTreasury() {
        const token = new ethers.Contract(this.contracts.token, ERC20_ABI, this.provider);

        const [symbol, decimals, splitterBalance] = await Promise.all([
            token.symbol(),
            token.decimals(),
            token.balanceOf(this.contracts.splitter)
        ]);

        const result = {
            token: {
                address: this.contracts.token,
                symbol,
                splitterBalance: ethers.formatUnits(splitterBalance, decimals)
            }
        };

        // Check USDC balance on testnet
        if (this.network === 'testnet' && this.contracts.usdc) {
            try {
                const usdc = new ethers.Contract(this.contracts.usdc, ERC20_ABI, this.provider);
                const usdcBalance = await usdc.balanceOf(this.contracts.governance);
                result.usdc = {
                    address: this.contracts.usdc,
                    balance: ethers.formatUnits(usdcBalance, 6)
                };
            } catch (e) {
                result.usdc = { error: e.message };
            }
        }

        return result;
    }

    // ========== WRITE FUNCTIONS ==========

    /**
     * Vote on a proposal
     */
    async vote(proposalId, support) {
        if (!this.wallet) {
            throw new Error('No private key configured. Set MOLTDAO_PRIVATE_KEY environment variable.');
        }

        const gov = new ethers.Contract(this.contracts.governance, GOVERNANCE_ABI, this.wallet);

        // Check if proposal is active
        const isActive = await gov.isProposalActive(proposalId);
        if (!isActive) {
            throw new Error(`Proposal ${proposalId} is not active for voting`);
        }

        // Check if already voted
        const hasVoted = await gov.hasUserVoted(proposalId, this.wallet.address);
        if (hasVoted) {
            throw new Error(`Already voted on proposal ${proposalId}`);
        }

        // Check voting power
        const power = await gov.getVotingPower(this.wallet.address);
        if (power === 0n) {
            throw new Error('No voting power. You need USDC tokens to vote.');
        }

        // Submit vote
        const tx = await gov.vote(proposalId, support);
        const receipt = await tx.wait();

        return {
            success: true,
            proposalId,
            support: support ? 'FOR' : 'AGAINST',
            votingPower: ethers.formatUnits(power, 18),
            txHash: tx.hash,
            explorer: `${this.explorer}/tx/${tx.hash}`
        };
    }

    /**
     * Donate USDC to treasury (testnet only)
     */
    async donateUSDC(amount) {
        if (this.network !== 'testnet') {
            throw new Error('USDC donation only available on testnet');
        }

        if (!this.wallet) {
            throw new Error('No private key configured');
        }

        const usdc = new ethers.Contract(this.contracts.usdc, ERC20_ABI, this.wallet);
        const amountWei = ethers.parseUnits(amount.toString(), 6);

        // Transfer to governance contract
        const tx = await usdc.transfer(this.contracts.governance, amountWei);
        const receipt = await tx.wait();

        return {
            success: true,
            amount: amount + ' USDC',
            to: this.contracts.governance,
            txHash: tx.hash,
            explorer: `${this.explorer}/tx/${tx.hash}`
        };
    }

    /**
     * Create a new proposal (owner only)
     */
    async createProposal(title, description) {
        if (!this.wallet) {
            throw new Error('No private key configured');
        }

        const gov = new ethers.Contract(this.contracts.governance, GOVERNANCE_ABI, this.wallet);
        const tx = await gov.createProposal(title, description);
        const receipt = await tx.wait();

        // Get the new proposal ID from events
        const proposalCount = await gov.proposalCount();

        return {
            success: true,
            proposalId: Number(proposalCount),
            title,
            txHash: tx.hash,
            explorer: `${this.explorer}/tx/${tx.hash}`
        };
    }
}

// ========== CLI INTERFACE ==========

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    const skill = new MoltDAOSkill({
        network: process.env.MOLTDAO_NETWORK || 'testnet'
    });

    console.log(`
🦀 MoltDAO Skill - ${skill.network.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

    try {
        switch (command) {
            case 'proposals':
                const proposals = await skill.getProposals();
                console.log('📋 Proposals:\n');
                if (proposals.length === 0) {
                    console.log('No proposals yet.');
                } else {
                    proposals.forEach(p => {
                        console.log(`#${p.id} - ${p.title}`);
                        console.log(`   Status: ${p.status} | Active: ${p.isActive}`);
                        console.log(`   Votes: ✅ ${p.yesVotes} FOR | ❌ ${p.noVotes} AGAINST`);
                        console.log(`   Ends: ${p.endTime.toLocaleString()}\n`);
                    });
                }
                break;

            case 'power':
                const address = args[1] || skill.wallet?.address;
                if (!address) {
                    console.log('Usage: node moltdao.js power <address>');
                    return;
                }
                const power = await skill.getVotingPower(address);
                console.log(`🗳️ Voting Power for ${power.address}:`);
                console.log(`   ${power.votingPower} votes`);
                break;

            case 'treasury':
                const treasury = await skill.getTreasury();
                console.log('💰 Treasury:\n');
                console.log(`   USDC in Splitter: ${treasury.token.splitterBalance}`);
                if (treasury.usdc) {
                    console.log(`   USDC in Governance: ${treasury.usdc.balance || treasury.usdc.error}`);
                }
                break;

            case 'vote':
                const proposalId = parseInt(args[1]);
                const support = args[2]?.toLowerCase() === 'for' || args[2] === 'true';
                if (!proposalId) {
                    console.log('Usage: node moltdao.js vote <proposal_id> <for|against>');
                    return;
                }
                const result = await skill.vote(proposalId, support);
                console.log(`✅ Vote submitted!`);
                console.log(`   Proposal: #${result.proposalId}`);
                console.log(`   Vote: ${result.support}`);
                console.log(`   Power: ${result.votingPower}`);
                console.log(`   TX: ${result.explorer}`);
                break;

            case 'donate':
                const amount = parseFloat(args[1]);
                if (!amount) {
                    console.log('Usage: node moltdao.js donate <amount_usdc>');
                    return;
                }
                const donation = await skill.donateUSDC(amount);
                console.log(`✅ Donation successful!`);
                console.log(`   Amount: ${donation.amount}`);
                console.log(`   TX: ${donation.explorer}`);
                break;

            default:
                console.log(`Commands:
  proposals          - List all proposals
  power [address]    - Check voting power
  treasury           - Check treasury balance
  vote <id> <for|against> - Vote on proposal
  donate <amount>    - Donate USDC (testnet)

Environment variables:
  MOLTDAO_NETWORK     - 'testnet' (default: testnet)
  MOLTDAO_PRIVATE_KEY - Your wallet private key for voting
`);
        }
    } catch (e) {
        console.error(`❌ Error: ${e.message}`);
    }
}

// Export for use as module
module.exports = { MoltDAOSkill, NETWORKS };

// Run CLI if called directly
if (require.main === module) {
    main().catch(console.error);
}
