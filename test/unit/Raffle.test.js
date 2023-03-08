const { assert, expect } = require("chai");
const { network, getNamedAccounts, deployments, ethers } = require("hardhat");
const { developmentChains, networkConfig } = require("../../helper-hardhat-config");

!developmentChains.includes(network.name) 
    ? describe.skip 
    : describe("Raffle Unit Tests", function () {
        let raffle, vrfCoordinatorV2, raffleEntranceFee, deployer, interval;
        const chainId = network.config.chainId;

        beforeEach(async function() {
            deployer = (await getNamedAccounts()).deployer;
            await deployments.fixture(["all"]);
            raffle = await ethers.getContract("Raffle", deployer);
            vrfCoordinatorV2 = await ethers.getContract("VRFCoordinatorV2Mock", deployer);
            raffleEntranceFee = await raffle.getEntranceFee();
            interval = await raffle.getInterval();
        })

        describe("constructor", function() {
            it("Initializes the raffle correctly", async function () {
                const raffleState = await raffle.getRaffleState();

                assert.equal(raffleState.toString(), "0");
                assert.equal(interval.toString(), networkConfig[chainId]["interval"]);
            })
        })

        describe("enter raffle", function() {
            it("should revert if you don't pay enough", async function() {
                await expect(raffle.enterRaffle()).to.be.revertedWith("Raffle__NotEnoughETHEntered");
            })
            it("updates players when entered", async function() {
                await raffle.enterRaffle({value: raffleEntranceFee});
                const playerFromContract = await raffle.getPlayer(0);
                assert.equal(playerFromContract, deployer);
            })
            it("should emit event on enter", async function() {
                await expect(raffle.enterRaffle({value: raffleEntranceFee})).to.emit(raffle, "RaffleEntered");
            })
            it("should not allow enter when calculating", async function() {
                await raffle.enterRaffle({value: raffleEntranceFee});
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                await network.provider.send("evm_mine", []);
                await raffle.performUpkeep([]);
                await expect(raffle.enterRaffle({value: raffleEntranceFee})).to.be.revertedWith("Raffle__NotOpen");
            })
        })

        describe("checkUpkeep", function() {
            it("should return false if people haven't send ETH", async function() {
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                await network.provider.send("evm_mine", []);
                const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([]);
                assert(!upkeepNeeded);
            })
            it("should return false if raffle is not open", async function() {
                await raffle.enterRaffle({value: raffleEntranceFee});
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                await network.provider.send("evm_mine", []);
                await raffle.performUpkeep([]);
                const raffleState = await raffle.getRaffleState();
                const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([]);
                assert.equal(raffleState.toString(), "1");
                assert(!upkeepNeeded);
            })
            it("returns false if enough time hasn't passed", async () => {
                await raffle.enterRaffle({ value: raffleEntranceFee });
                await network.provider.send("evm_increaseTime", [interval.toNumber() - 5]); // use a higher number here if this test fails
                await network.provider.request({ method: "evm_mine", params: [] });
                const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x"); // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                assert(!upkeepNeeded);
            })
            it("returns true if enough time has passed, has players, eth, and is open", async () => {
                await raffle.enterRaffle({ value: raffleEntranceFee });
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                await network.provider.request({ method: "evm_mine", params: [] });
                const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x"); // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                assert(upkeepNeeded);
            })
        })

        describe("performUpkeep", function() {
            it("should only run if checkUpkeep returns true", async function() {
                await raffle.enterRaffle({ value: raffleEntranceFee });
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                await network.provider.request({ method: "evm_mine", params: [] });
                const tx = await raffle.performUpkeep([]);
                assert(tx);
            })
            it("should revert if checkUpkeep is false", async function() {
                await expect(raffle.performUpkeep([])).to.be.revertedWith("Raffle__UpkeepNotNeeded");
            })
            it("should update the state, emit an event and call the vrf coordinator", async function() {
                await raffle.enterRaffle({value: raffleEntranceFee});
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                await network.provider.send("evm_mine", []);
                const txResponse = await raffle.performUpkeep([]);
                const txReceipt = await txResponse.wait(1);
                const requestId = txReceipt.events[1].args.requestId;
                const raffleState = await raffle.getRaffleState();
                assert(requestId.toNumber() > 0);
                assert.equal(raffleState.toString(), "1");
            })
        })
        describe("fulfillRandomWords", function() {
            beforeEach(async function() {
                await raffle.enterRaffle({value: raffleEntranceFee});
                await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                await network.provider.send("evm_mine", []);
            })
            it("can only be called after performUpkeep", async function() {
                await expect(
                    vrfCoordinatorV2.fulfillRandomWords(0, raffle.address)
                ).to.be.revertedWith("nonexistent request");
                await expect(
                    vrfCoordinatorV2.fulfillRandomWords(1, raffle.address)
                ).to.be.revertedWith("nonexistent request");
            })
            it("picks a winner, resets the lottery, and sends money", async function() {
                const additionalEntrants = 3;
                const startingAccountIndex = 1;
                const accounts = await ethers.getSigners();
                for (let i = startingAccountIndex; i < startingAccountIndex + additionalEntrants; i++) {
                    const accountConnectedRaffle = raffle.connect(accounts[i]);
                    await accountConnectedRaffle.enterRaffle({value: raffleEntranceFee});
                }
                const startingTimeStamp = await raffle.getLastTimeStamp()

                await new Promise(async (resolve, reject) => {
                    raffle.once("WinnerPicked", async () => {
                        console.log("Found the event!");
                        try {
                            const recentWinner = await raffle.getRecentWinner();
                            const raffleState = await raffle.getRaffleState();
                            const endingTimeStamp = await raffle.getLastTimeStamp();
                            const numPlayers = await raffle.getNumberOfPlayers();
                            const winnerEndingBalance = await accounts[1].getBalance();
                            assert.equal(numPlayers.toString(), "0");
                            assert.equal(raffleState.toString(), "0");
                            assert(endingTimeStamp > startingTimeStamp);
                            assert.equal(
                                winnerEndingBalance.toString(),
                                winnerStartingBalance
                                    .add(
                                        raffleEntranceFee
                                            .mul(additionalEntrants + 1)
                                    )
                                    .toString()
                            )
                            resolve();
                        } catch(e) {
                            reject(e)
                        }
                    })

                    const tx = await raffle.performUpkeep([]);
                    const txReceipt = await tx.wait(1);
                    const winnerStartingBalance = await accounts[1].getBalance();
                    await vrfCoordinatorV2.fulfillRandomWords(
                        txReceipt.events[1].args.requestId,
                        raffle.address
                    )
                })
            })
        })
    })