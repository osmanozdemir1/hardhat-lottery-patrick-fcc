const { assert, expect } = require("chai");
const { network, getNamedAccounts, deployments, ethers } = require("hardhat");
const { developmentChains, networkConfig } = require("../../helper-hardhat-config");

const GOERLI_RPC_URL = process.env.GOERLI_RPC_URL
const provier = new ethers.providers.JsonRpcProvider(GOERLI_RPC_URL);

developmentChains.includes(network.name) 
    ? describe.skip 
    : describe("Raffle Staging Tests", function () {
        let raffle, raffleEntranceFee, deployer;

        beforeEach(async function() {
            deployer = (await getNamedAccounts()).deployer;
            raffle = await ethers.getContract("Raffle", deployer);
            raffleEntranceFee = await raffle.getEntranceFee();
        })

        describe("fulfillRandomWords", function() {
            it("works with live Chainlink keepers and Chainlink VRF, we get a random winner", async function() {
                const startingTimeStamp = await raffle.getLastTimeStamp();
                const accounts = await ethers.getSigners();

                await new Promise(async (resolve, reject) => {
                    raffle.once("WinnerPicked", async (arg1, event) => {
                        console.log("Winner picked event is heard");
                        const txHash = event.transactionHash;
                        const txReceipt = await provier.getTransaction(txHash);
                        const gasUsed = txReceipt.gasUsed;
                        const gasPrice = txReceipt.effectiveGasPrice;
                        const gasCost = gasUsed.mul(gasPrice);
                        try {
                            const recentWinner = await raffle.getRecentWinner();
                            const raffleState = await raffle.getRaffleState();
                            const winnerEndingBalance = await accounts[0].getBalance();
                            const endingTimeStamp = await raffle.getLastTimeStamp();

                            await expect(raffle.getPlayer(0)).to.be.reverted;
                            assert.equal(recentWinner.toString(), accounts[0].address);
                            assert.equal(raffleState, 0);
                            assert.equal(
                                winnerEndingBalance.toString(), 
                                winnerStartingBalance
                                    .add(raffleEntranceFee)
                                    .sub(gasCost)
                                    .toString());
                            assert(endingTimeStamp > startingTimeStamp);
                            resolve();
                        } catch(error) {
                            console.log(error);
                            reject;
                        }
                    })

                    const tx = await raffle.enterRaffle({value: raffleEntranceFee});
                    await tx.wait(1);
                    const winnerStartingBalance = await accounts[0].getBalance();
                })
            })
        })
    })