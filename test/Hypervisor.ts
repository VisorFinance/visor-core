import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber, constants, Wallet } from 'ethers';
import { formatEther, parseUnits, randomBytes } from 'ethers/lib/utils'
import { deployContract, signPermission, signPermitEIP2612 } from './utils'

let owner: any, alice: any, bob: any, carol: any,
    stakingToken: any, rewardToken: any, visorTemplate: any, visorFactory: any, visor: any,
    rewardPoolFactory: any, powerSwitchFactory: any, hypervisor: any, mainframe: any,
    signerWallet: Wallet;

const DAY = 60 * 60 * 24;
const REWARD_FUND_AMOUNT = 1000000;

describe("Test Staking Reward", function() {
  beforeEach(async function() {
    [owner, alice, bob, carol] = await ethers.getSigners();

    // Deploy tokens for staking and rewards
    const StakingToken = await ethers.getContractFactory("StakingToken");
    const RewardToken = await ethers.getContractFactory("RewardToken");

    stakingToken = await StakingToken.deploy(owner.address);
    rewardToken = await RewardToken.deploy(owner.address);

    // Checking that token contracts have successfully deployed & credited
    // owner with tokens
    const ownerBalance = await stakingToken.balanceOf(owner.address);
    expect(await stakingToken.totalSupply()).to.equal(ownerBalance);

    const ownerRewardBalance = await rewardToken.balanceOf(owner.address);
    expect(await rewardToken.totalSupply()).to.equal(ownerBalance);

    // Deploy VisorFactory & Visor template
    const VisorFactory = await ethers.getContractFactory("VisorFactory");
    const Visor = await ethers.getContractFactory("Visor");

    visorTemplate = await Visor.deploy();
    visorFactory = await VisorFactory.deploy();

    await visorTemplate.initializeLock();

    const name = ethers.utils.formatBytes32String('VISOR-1.0.0')
    const tx = await visorFactory.addTemplate(name, visorTemplate.address);

    console.log('addTemplate tx ', tx.hash);

    // Deploy user's Visor
    visor = await ethers.getContractAt(
      'Visor',
      await visorFactory.callStatic['create()'](),
    )

    await visorFactory['create()']();

    // Deploy Hypervisor & required factoriees
    const RewardPoolFactory = await ethers.getContractFactory("RewardPoolFactory");
    rewardPoolFactory = await RewardPoolFactory.deploy();

    const PowerSwitchFactory = await ethers.getContractFactory("PowerSwitchFactory");
    powerSwitchFactory = await PowerSwitchFactory.deploy();

    const Hypervisor = await ethers.getContractFactory("Hypervisor");
    hypervisor = await Hypervisor.deploy(owner.address, rewardPoolFactory.address, powerSwitchFactory.address, stakingToken.address, rewardToken.address, [0, 1000, 28 * DAY], 25000);

    // Fund Hypervisor

    console.log('Approve reward deposit')
    const approveTx = await rewardToken.approve(hypervisor.address, constants.MaxUint256);
    await approveTx.wait();
    console.log('  in', approveTx.hash);

    // Register Vault Factory
    await hypervisor.registerVaultFactory(visorFactory.address);

    // Deploy Mainframe
    const Mainframe = await ethers.getContractFactory("Mainframe");
    mainframe = await Mainframe.deploy();

    // Permit and Stake
    signerWallet = Wallet.fromMnemonic(process.env.DEV_MNEMONIC || '')
    expect(owner.address).to.be.eq(signerWallet.address);
  });

  describe("Fund once for 40 days", function() {
    beforeEach(async function() {
      console.log('Deposit reward');
      const depositTx = await hypervisor.fund(REWARD_FUND_AMOUNT, 40 * DAY);
      console.log('  in', depositTx.hash);
    })

    it("Deployment should assign the total supply of tokens to the owner", async function() {

      const amount = 1000;
  
      let permission = await signPermission(
        'Lock',
        visor,
        signerWallet,
        hypervisor.address,
        stakingToken.address,
        amount,
        0,
      );
  
      await stakingToken.approve(mainframe.address, ethers.constants.MaxUint256);
  
      await mainframe.stake(hypervisor.address, visor.address, amount, permission);
  
      // after staking `amount`, expect visor value locked to be `amount`
      let balanceLocked = await visor.getBalanceLocked(stakingToken.address);
      expect(balanceLocked).to.equal(amount);
      let lockSetCount = await visor.getLockSetCount();
      expect(lockSetCount).to.equal(1);
  
      //unclaim and stake
      let nonce = await visor.getNonce()
  
      const unlockPermission = await signPermission(
        'Unlock',
        visor,
        signerWallet,
        hypervisor.address,
        stakingToken.address,
        amount,
        nonce,
      )
  
      await hypervisor.unstakeAndClaim(
        visor.address,
        amount,
        unlockPermission,
      )
  
      // after unstaking `amount`, expect visor value locked to be 0
      balanceLocked = await visor.getBalanceLocked(stakingToken.address);
      expect(balanceLocked).to.equal(0);
      lockSetCount = await visor.getLockSetCount();
      expect(lockSetCount).to.equal(0);
  
      // Test Stakelimit
      nonce = await visor.getNonce()
      permission = await signPermission(
        'Lock',
        visor,
        signerWallet,
        hypervisor.address,
        stakingToken.address,
        amount*30,
        nonce,
      )
      await expect(mainframe.stake(hypervisor.address, visor.address, amount*30, permission)).to.be.revertedWith("Hypervisor: Stake limit exceeded");
  
      // Test RAGEQUIT
      nonce = await visor.getNonce()
      permission = await signPermission(
        'Lock',
        visor,
        signerWallet,
        hypervisor.address,
        stakingToken.address,
        amount*20,
        nonce,
      )
  
      await mainframe.stake(hypervisor.address, visor.address, amount*20, permission);
  
      // after stake, expect balance locked to be equal to 2xamount
      balanceLocked = await visor.getBalanceLocked(stakingToken.address);
      lockSetCount = await visor.getLockSetCount();
      expect(lockSetCount).to.equal(1);
      expect(balanceLocked).to.equal(amount*20);
  
      await visor.rageQuit(hypervisor.address, stakingToken.address);
    });
  
    it("Should get the full rewards after the locking period", async function() {
  
      const initialBalance = 10000000000; // 1e10
  
      // Fund the token to the users
      stakingToken.transfer(alice.address, initialBalance);
      expect(await stakingToken.balanceOf(alice.address)).to.equal(initialBalance);
      stakingToken.transfer(bob.address, initialBalance);
      expect(await stakingToken.balanceOf(bob.address)).to.equal(initialBalance);
      stakingToken.transfer(carol.address, initialBalance);
      expect(await stakingToken.balanceOf(carol.address)).to.equal(initialBalance);
  
      const amountAlice = 100, amountBob = 200, amountCarol = 500;
  
      // Deploy Visor of each user
      let visorAlice = await ethers.getContractAt(
        'Visor',
        await visorFactory.connect(alice).callStatic['create()'](),
      )
      await visorFactory.connect(alice)['create()']();
  
      let visorBob = await ethers.getContractAt(
        'Visor',
        await visorFactory.connect(bob).callStatic['create()'](),
      )
      await visorFactory.connect(bob)['create()']();
  
      let visorCarol = await ethers.getContractAt(
        'Visor',
        await visorFactory.connect(carol).callStatic['create()'](),
      )
      await visorFactory.connect(carol)['create()']();
  
      // Stake
      let nonce: number;
      nonce = await visorAlice.getNonce();
      let permissionAlice = await signPermission(
        'Lock',
        visorAlice,
        alice,
        hypervisor.address,
        stakingToken.address,
        amountAlice,
        nonce,
      );
  
      nonce = await visorBob.getNonce();
      let permissionBob = await signPermission(
        'Lock',
        visorBob,
        bob,
        hypervisor.address,
        stakingToken.address,
        amountBob,
        nonce,
      );
  
      nonce = await visorCarol.getNonce();
      let permissionCarol = await signPermission(
        'Lock',
        visorCarol,
        carol,
        hypervisor.address,
        stakingToken.address,
        amountCarol,
        nonce,
      );
  
      await stakingToken.connect(alice).approve(mainframe.address, amountAlice);
      await stakingToken.connect(bob).approve(mainframe.address, amountBob);
      await stakingToken.connect(carol).approve(mainframe.address, amountCarol);
  
      await mainframe.connect(alice).stake(hypervisor.address, visorAlice.address, amountAlice, permissionAlice);
      await mainframe.connect(bob).stake(hypervisor.address, visorBob.address, amountBob, permissionBob);
      await mainframe.connect(carol).stake(hypervisor.address, visorCarol.address, amountCarol, permissionCarol);
  
      // After staking `amount`, expect visor value locked to be `amount`
      let totalStakingBalance = BigNumber.from(amountAlice).add(BigNumber.from(amountBob)).add(BigNumber.from(amountCarol));
      let balanceLockedAlice = await visorAlice.getBalanceLocked(stakingToken.address);
      let balanceLockedBob = await visorBob.getBalanceLocked(stakingToken.address);
      let balanceLockedCarol = await visorCarol.getBalanceLocked(stakingToken.address);
      expect(balanceLockedAlice.add(balanceLockedBob).add(balanceLockedCarol)).to.equal(totalStakingBalance);
  
      let lockSetCount = await visorAlice.getLockSetCount();
      expect(lockSetCount).to.equal(1);
      lockSetCount = await visorBob.getLockSetCount();
      expect(lockSetCount).to.equal(1);
      lockSetCount = await visorCarol.getLockSetCount();
      expect(lockSetCount).to.equal(1);
  
      // Unstake and claim
      nonce = await visorAlice.getNonce()
      let unlockPermissionAlice = await signPermission(
        'Unlock',
        visorAlice,
        alice,
        hypervisor.address,
        stakingToken.address,
        amountAlice,
        nonce,
      );
  
      nonce = await visorBob.getNonce()
      let unlockPermissionBob = await signPermission(
        'Unlock',
        visorBob,
        bob,
        hypervisor.address,
        stakingToken.address,
        amountBob,
        nonce,
      );
  
      nonce = await visorCarol.getNonce()
      let unlockPermissionCarol = await signPermission(
        'Unlock',
        visorCarol,
        carol,
        hypervisor.address,
        stakingToken.address,
        amountCarol,
        nonce,
      );
  
      await ethers.provider.send("evm_increaseTime", [40 * DAY]);
      await ethers.provider.send("evm_mine", []);
      
      await hypervisor.connect(alice).unstakeAndClaim(
        visorAlice.address,
        amountAlice,
        unlockPermissionAlice,
        );
        
      await hypervisor.connect(bob).unstakeAndClaim(
        visorBob.address,
        amountBob,
        unlockPermissionBob,
        );
        
      await hypervisor.connect(carol).unstakeAndClaim(
        visorCarol.address,
        amountCarol,
        unlockPermissionCarol,
        );  
  
      // After unstaking `amount`, expect visor value locked to be 0
      balanceLockedAlice = await visorAlice.getBalanceLocked(stakingToken.address);
      expect(balanceLockedAlice).to.equal(0);
      balanceLockedBob = await visorBob.getBalanceLocked(stakingToken.address);
      expect(balanceLockedBob).to.equal(0);
      balanceLockedCarol = await visorCarol.getBalanceLocked(stakingToken.address);
      expect(balanceLockedCarol).to.equal(0);
  
      lockSetCount = await visorAlice.getLockSetCount();
      expect(lockSetCount).to.equal(0);
      lockSetCount = await visorBob.getLockSetCount();
      expect(lockSetCount).to.equal(0);
      lockSetCount = await visorCarol.getLockSetCount();
      expect(lockSetCount).to.equal(0);
  
      // Check reward of each user
      let rewardAlice = await rewardToken.balanceOf(alice.address);
      let rewardBob = await rewardToken.balanceOf(bob.address);
      let rewardCarol = await rewardToken.balanceOf(carol.address);
      
      let rewardAliceExpected = BigNumber.from(REWARD_FUND_AMOUNT).mul(BigNumber.from(amountAlice)).div(totalStakingBalance);
      let rewardBobExpected = BigNumber.from(REWARD_FUND_AMOUNT).mul(BigNumber.from(amountBob)).div(totalStakingBalance);
      let rewardCarolExpected = BigNumber.from(REWARD_FUND_AMOUNT).mul(BigNumber.from(amountCarol)).div(totalStakingBalance);
      
      expect(rewardAlice).to.equal(rewardAliceExpected)
      expect(rewardBob).to.equal(rewardBobExpected)
      expect(rewardCarol).to.equal(rewardCarolExpected)
    });
  
    it("Should get the proper rewards if the user unstake and claim in the middle of the locking period", async function() {
  
      const initialBalance = 10000000000; // 1e10
  
      // Fund the token to the users
      stakingToken.transfer(alice.address, initialBalance);
      expect(await stakingToken.balanceOf(alice.address)).to.equal(initialBalance);
      stakingToken.transfer(bob.address, initialBalance);
      expect(await stakingToken.balanceOf(bob.address)).to.equal(initialBalance);
      stakingToken.transfer(carol.address, initialBalance);
      expect(await stakingToken.balanceOf(carol.address)).to.equal(initialBalance);
  
      const amountAlice = 100, amountBob = 200, amountCarol = 500;
  
      // Deploy Visor of each user
      let visorAlice = await ethers.getContractAt(
        'Visor',
        await visorFactory.connect(alice).callStatic['create()'](),
      )
      await visorFactory.connect(alice)['create()']();
  
      let visorBob = await ethers.getContractAt(
        'Visor',
        await visorFactory.connect(bob).callStatic['create()'](),
      )
      await visorFactory.connect(bob)['create()']();
  
      let visorCarol = await ethers.getContractAt(
        'Visor',
        await visorFactory.connect(carol).callStatic['create()'](),
      )
      await visorFactory.connect(carol)['create()']();
  
      // Stake
      let nonce: number;
      nonce = await visorAlice.getNonce();
      let permissionAlice = await signPermission(
        'Lock',
        visorAlice,
        alice,
        hypervisor.address,
        stakingToken.address,
        amountAlice,
        nonce,
      );
  
      nonce = await visorBob.getNonce();
      let permissionBob = await signPermission(
        'Lock',
        visorBob,
        bob,
        hypervisor.address,
        stakingToken.address,
        amountBob,
        nonce,
      );
  
      nonce = await visorCarol.getNonce();
      let permissionCarol = await signPermission(
        'Lock',
        visorCarol,
        carol,
        hypervisor.address,
        stakingToken.address,
        amountCarol,
        nonce,
      );
  
      await stakingToken.connect(alice).approve(mainframe.address, amountAlice);
      await stakingToken.connect(bob).approve(mainframe.address, amountBob);
      await stakingToken.connect(carol).approve(mainframe.address, amountCarol);
  
      await mainframe.connect(alice).stake(hypervisor.address, visorAlice.address, amountAlice, permissionAlice);
      await mainframe.connect(bob).stake(hypervisor.address, visorBob.address, amountBob, permissionBob);
      await mainframe.connect(carol).stake(hypervisor.address, visorCarol.address, amountCarol, permissionCarol);
  
      // After staking `amount`, expect visor value locked to be `amount`
      let totalStakingBalance = BigNumber.from(amountAlice).add(BigNumber.from(amountBob)).add(BigNumber.from(amountCarol));
      let balanceLockedAlice = await visorAlice.getBalanceLocked(stakingToken.address);
      let balanceLockedBob = await visorBob.getBalanceLocked(stakingToken.address);
      let balanceLockedCarol = await visorCarol.getBalanceLocked(stakingToken.address);
      expect(balanceLockedAlice.add(balanceLockedBob).add(balanceLockedCarol)).to.equal(totalStakingBalance);
  
      let lockSetCount = await visorAlice.getLockSetCount();
      expect(lockSetCount).to.equal(1);
      lockSetCount = await visorBob.getLockSetCount();
      expect(lockSetCount).to.equal(1);
      lockSetCount = await visorCarol.getLockSetCount();
      expect(lockSetCount).to.equal(1);
  
      // Unstake and claim
      nonce = await visorAlice.getNonce()
      let unlockPermissionAlice = await signPermission(
        'Unlock',
        visorAlice,
        alice,
        hypervisor.address,
        stakingToken.address,
        amountAlice,
        nonce,
      );
  
      nonce = await visorBob.getNonce()
      let unlockPermissionBob = await signPermission(
        'Unlock',
        visorBob,
        bob,
        hypervisor.address,
        stakingToken.address,
        amountBob,
        nonce,
      );
  
      nonce = await visorCarol.getNonce()
      let unlockPermissionCarol = await signPermission(
        'Unlock',
        visorCarol,
        carol,
        hypervisor.address,
        stakingToken.address,
        amountCarol,
        nonce,
      );
  
      await ethers.provider.send("evm_increaseTime", [30 * DAY]);
      await ethers.provider.send("evm_mine", []);
      
      await hypervisor.connect(alice).unstakeAndClaim(
        visorAlice.address,
        amountAlice,
        unlockPermissionAlice,
        );
        
      await hypervisor.connect(bob).unstakeAndClaim(
        visorBob.address,
        amountBob,
        unlockPermissionBob,
        );
        
      await hypervisor.connect(carol).unstakeAndClaim(
        visorCarol.address,
        amountCarol,
        unlockPermissionCarol,
        );  
  
      // After unstaking `amount`, expect visor value locked to be 0
      balanceLockedAlice = await visorAlice.getBalanceLocked(stakingToken.address);
      expect(balanceLockedAlice).to.equal(0);
      balanceLockedBob = await visorBob.getBalanceLocked(stakingToken.address);
      expect(balanceLockedBob).to.equal(0);
      balanceLockedCarol = await visorCarol.getBalanceLocked(stakingToken.address);
      expect(balanceLockedCarol).to.equal(0);
  
      lockSetCount = await visorAlice.getLockSetCount();
      expect(lockSetCount).to.equal(0);
      lockSetCount = await visorBob.getLockSetCount();
      expect(lockSetCount).to.equal(0);
      lockSetCount = await visorCarol.getLockSetCount();
      expect(lockSetCount).to.equal(0);
  
      // Check reward of each user
      let rewardAlice = await rewardToken.balanceOf(alice.address);
      let rewardBob = await rewardToken.balanceOf(bob.address);
      let rewardCarol = await rewardToken.balanceOf(carol.address);
  
      let rewardAliceExpected = BigNumber.from(REWARD_FUND_AMOUNT*30/40).mul(BigNumber.from(amountAlice)).div(totalStakingBalance);
      let rewardBobExpected = BigNumber.from(REWARD_FUND_AMOUNT*30/40).mul(BigNumber.from(amountBob)).div(totalStakingBalance);
      let rewardCarolExpected = BigNumber.from(REWARD_FUND_AMOUNT*30/40).mul(BigNumber.from(amountCarol)).div(totalStakingBalance);
  
      expect(Number(rewardAlice)).to.be.closeTo(Number(rewardAliceExpected), 1000);
      expect(Number(rewardBob)).to.be.closeTo(Number(rewardBobExpected), 1000);
      expect(Number(rewardCarol)).to.be.closeTo(Number(rewardCarolExpected), 1000);
    });
  });
  
  describe("Fund the variable reward every day for 40 days", function() {
    it("Should get the full rewards after the locking period", async function() {
      
      const initialBalance = 10000000000; // 1e10
      const amountAlice = 100, amountBob = 200, amountCarol = 500;
      const TOTAL_PERIOD = 40, STAKING_PERIOD = 40;

      let visorAlice: any, visorBob: any, visorCarol: any,
          balanceLockedAlice: any, balanceLockedBob: any, balanceLockedCarol: any, totalStakingBalance: any,
          lockSetCount: number,
          nonce: number,
          baseRewardPerDay = 10, rewardAmount = 0;

      for (let i = 0; i < TOTAL_PERIOD && i < STAKING_PERIOD; i++) {
        rewardAmount = baseRewardPerDay * (i + 1);  // 10, 20, ..., 400
        console.log('Deposit reward ', rewardAmount);
        const depositTx = await hypervisor.fund(rewardAmount, 1 * DAY);
        console.log('  in', depositTx.hash);

        if (i == 0) {
          // Fund the token to the users
          stakingToken.transfer(alice.address, initialBalance);
          expect(await stakingToken.balanceOf(alice.address)).to.equal(initialBalance);
          stakingToken.transfer(bob.address, initialBalance);
          expect(await stakingToken.balanceOf(bob.address)).to.equal(initialBalance);
          stakingToken.transfer(carol.address, initialBalance);
          expect(await stakingToken.balanceOf(carol.address)).to.equal(initialBalance);
      
          // Deploy Visor of each user
          visorAlice = await ethers.getContractAt(
            'Visor',
            await visorFactory.connect(alice).callStatic['create()'](),
          )
          await visorFactory.connect(alice)['create()']();
      
          visorBob = await ethers.getContractAt(
            'Visor',
            await visorFactory.connect(bob).callStatic['create()'](),
          )
          await visorFactory.connect(bob)['create()']();
      
          visorCarol = await ethers.getContractAt(
            'Visor',
            await visorFactory.connect(carol).callStatic['create()'](),
          )
          await visorFactory.connect(carol)['create()']();
      
          // Stake
          nonce = await visorAlice.getNonce();
          let permissionAlice = await signPermission(
            'Lock',
            visorAlice,
            alice,
            hypervisor.address,
            stakingToken.address,
            amountAlice,
            nonce,
          );
      
          nonce = await visorBob.getNonce();
          let permissionBob = await signPermission(
            'Lock',
            visorBob,
            bob,
            hypervisor.address,
            stakingToken.address,
            amountBob,
            nonce,
          );
      
          nonce = await visorCarol.getNonce();
          let permissionCarol = await signPermission(
            'Lock',
            visorCarol,
            carol,
            hypervisor.address,
            stakingToken.address,
            amountCarol,
            nonce,
          );
      
          await stakingToken.connect(alice).approve(mainframe.address, amountAlice);
          await stakingToken.connect(bob).approve(mainframe.address, amountBob);
          await stakingToken.connect(carol).approve(mainframe.address, amountCarol);
      
          await mainframe.connect(alice).stake(hypervisor.address, visorAlice.address, amountAlice, permissionAlice);
          await mainframe.connect(bob).stake(hypervisor.address, visorBob.address, amountBob, permissionBob);
          await mainframe.connect(carol).stake(hypervisor.address, visorCarol.address, amountCarol, permissionCarol);
      
          // After staking `amount`, expect visor value locked to be `amount`
          totalStakingBalance = BigNumber.from(amountAlice).add(BigNumber.from(amountBob)).add(BigNumber.from(amountCarol));
          balanceLockedAlice = await visorAlice.getBalanceLocked(stakingToken.address);
          balanceLockedBob = await visorBob.getBalanceLocked(stakingToken.address);
          balanceLockedCarol = await visorCarol.getBalanceLocked(stakingToken.address);
          expect(balanceLockedAlice.add(balanceLockedBob).add(balanceLockedCarol)).to.equal(totalStakingBalance);
      
          lockSetCount = await visorAlice.getLockSetCount();
          expect(lockSetCount).to.equal(1);
          lockSetCount = await visorBob.getLockSetCount();
          expect(lockSetCount).to.equal(1);
          lockSetCount = await visorCarol.getLockSetCount();
          expect(lockSetCount).to.equal(1);
        }
        
        // Pass 1 day
        await ethers.provider.send("evm_increaseTime", [1 * DAY]);
        await ethers.provider.send("evm_mine", []);
      }

      // Unstake and claim
      nonce = await visorAlice.getNonce()
      let unlockPermissionAlice = await signPermission(
        'Unlock',
        visorAlice,
        alice,
        hypervisor.address,
        stakingToken.address,
        amountAlice,
        nonce,
      );

      nonce = await visorBob.getNonce()
      let unlockPermissionBob = await signPermission(
        'Unlock',
        visorBob,
        bob,
        hypervisor.address,
        stakingToken.address,
        amountBob,
        nonce,
      );

      nonce = await visorCarol.getNonce()
      let unlockPermissionCarol = await signPermission(
        'Unlock',
        visorCarol,
        carol,
        hypervisor.address,
        stakingToken.address,
        amountCarol,
        nonce,
      );

      await hypervisor.connect(alice).unstakeAndClaim(
        visorAlice.address,
        amountAlice,
        unlockPermissionAlice,
        );
        
      await hypervisor.connect(bob).unstakeAndClaim(
        visorBob.address,
        amountBob,
        unlockPermissionBob,
        );
        
      await hypervisor.connect(carol).unstakeAndClaim(
        visorCarol.address,
        amountCarol,
        unlockPermissionCarol,
        );  
  
      // After unstaking `amount`, expect visor value locked to be 0
      balanceLockedAlice = await visorAlice.getBalanceLocked(stakingToken.address);
      expect(balanceLockedAlice).to.equal(0);
      balanceLockedBob = await visorBob.getBalanceLocked(stakingToken.address);
      expect(balanceLockedBob).to.equal(0);
      balanceLockedCarol = await visorCarol.getBalanceLocked(stakingToken.address);
      expect(balanceLockedCarol).to.equal(0);
  
      lockSetCount = await visorAlice.getLockSetCount();
      expect(lockSetCount).to.equal(0);
      lockSetCount = await visorBob.getLockSetCount();
      expect(lockSetCount).to.equal(0);
      lockSetCount = await visorCarol.getLockSetCount();
      expect(lockSetCount).to.equal(0);
  
      // Check reward of each user
      let rewardAlice = await rewardToken.balanceOf(alice.address);
      let rewardBob = await rewardToken.balanceOf(bob.address);
      let rewardCarol = await rewardToken.balanceOf(carol.address);

      let rewardAmonuntUsedForStaking = BigNumber.from((STAKING_PERIOD + 1) * STAKING_PERIOD / 2 * baseRewardPerDay);  // (STAKING_PERIOD + 1) / 2  => 1+2+...+10 = (10+1) * 10 /2
  
      let rewardAliceExpected = BigNumber.from(rewardAmonuntUsedForStaking).mul(BigNumber.from(amountAlice)).div(totalStakingBalance);
      let rewardBobExpected = BigNumber.from(rewardAmonuntUsedForStaking).mul(BigNumber.from(amountBob)).div(totalStakingBalance);
      let rewardCarolExpected = BigNumber.from(rewardAmonuntUsedForStaking).mul(BigNumber.from(amountCarol)).div(totalStakingBalance);

      expect(Number(rewardAlice)).to.equal(Number(rewardAliceExpected));
      expect(Number(rewardBob)).to.equal(Number(rewardBobExpected));
      expect(Number(rewardCarol)).to.equal(Number(rewardCarolExpected));
    });
  })
});
