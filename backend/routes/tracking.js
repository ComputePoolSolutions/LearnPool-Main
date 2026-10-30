const express = require('express');
const LmsItem = require('../models/LmsItem');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const router = express.Router();
router.use(protect);

router.post('/start', async (req,res,next)=>{
  try{
    const recent=await LmsItem.findOne({type:'sessions',owner:req.user._id,'data.status':'active','data.lastHeartbeatAt':{$gte:new Date(Date.now()-2*60*60*1000)}}).sort({createdAt:-1});
    if(recent)return res.json({success:true,data:{id:recent._id,startedAt:recent.data.startedAt}});
    const item=await LmsItem.create({type:'sessions',owner:req.user._id,data:{startedAt:new Date(),lastHeartbeatAt:new Date(),activeSeconds:0,status:'active'}});
    res.status(201).json({success:true,data:{id:item._id,startedAt:item.data.startedAt}});
  }catch(e){next(e)}
});
router.post('/:id/heartbeat',async(req,res,next)=>{
  try{
    const item=await LmsItem.findOne({_id:req.params.id,type:'sessions',owner:req.user._id,'data.status':'active'});
    if(!item)return res.status(404).json({success:false,message:'Learning session not found.'});
    const now=new Date(),last=new Date(item.data.lastHeartbeatAt||item.data.startedAt),seconds=Math.max(0,Math.min(90,Math.floor((now-last)/1000)));
    item.data.activeSeconds=(item.data.activeSeconds||0)+seconds;item.data.lastHeartbeatAt=now;await item.save();
    await User.updateOne({_id:req.user._id},{$inc:{studySeconds:seconds}});
    res.json({success:true,data:{activeSeconds:item.data.activeSeconds}});
  }catch(e){next(e)}
});
router.post('/:id/end',async(req,res,next)=>{
  try{
    const item=await LmsItem.findOne({_id:req.params.id,type:'sessions',owner:req.user._id,'data.status':'active'});
    if(!item)return res.json({success:true});
    const now=new Date(),last=new Date(item.data.lastHeartbeatAt||item.data.startedAt),seconds=Math.max(0,Math.min(90,Math.floor((now-last)/1000)));
    item.data.activeSeconds=(item.data.activeSeconds||0)+seconds;item.data.lastHeartbeatAt=now;item.data.endedAt=now;item.data.status='ended';await item.save();
    await User.updateOne({_id:req.user._id},{$inc:{studySeconds:seconds}});res.json({success:true});
  }catch(e){next(e)}
});
router.get('/leaderboard',async(req,res,next)=>{
  try{
    const users=await User.find({status:'active',role:'student'}).select('name points profilePicture').sort({points:-1}).limit(10).lean();
    res.json({success:true,data:users.map((u,i)=>({rank:i+1,name:u.name,points:u.points||0,profilePicture:u.profilePicture||''}))});
  }catch(e){next(e)}
});
module.exports=router;
