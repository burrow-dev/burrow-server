package com.sbi.graphics
{
   import flash.display.DisplayObject;
   import flash.display.Sprite;
   import flash.geom.Rectangle;
   import flash.utils.Dictionary;
   
   public class SortLayer extends Sprite
   {
      
      private var _bottoms:Dictionary;

      private var _denRanks:Dictionary;
      
      private var _nudge:Number = 0;
      
      private var _throttle:int;
      
      public function SortLayer()
      {
         super();
         _bottoms = new Dictionary(true);
         _denRanks = new Dictionary(true);
      }
      
      override public function addChild(param1:DisplayObject) : DisplayObject
      {
         var _loc2_:int = int(param1.name);
         param1.name = (getNudge() + _loc2_).toString();
         return super.addChild(param1);
      }
      
      override public function addChildAt(param1:DisplayObject, param2:int) : DisplayObject
      {
         var _loc3_:int = int(param1.name);
         param1.name = (getNudge() + _loc3_).toString();
         return super.addChildAt(param1,param2);
      }
      
      public function release() : void
      {
         _nudge = 0;
         _bottoms = new Dictionary(true);
         _denRanks = new Dictionary(true);
      }

      public function setDenRank(param1:DisplayObject, param2:int, param3:Boolean = true) : void
      {
         _denRanks[param1] = param2;
         if(param3)
         {
            sortNow();
         }
      }

      public function clearDenRank(param1:DisplayObject) : void
      {
         delete _denRanks[param1];
         sortNow();
      }

      public function isRankedDenItem(param1:DisplayObject) : Boolean
      {
         return _denRanks[param1] !== undefined;
      }

      public function getDenRank(param1:DisplayObject) : int
      {
         return isRankedDenItem(param1) ? int(_denRanks[param1]) : -1;
      }
      
      public function depthSort(param1:DisplayObject, param2:DisplayObject) : int
      {
         return _bottoms[param1] - _bottoms[param2];
      }
      
      public function heartbeat() : void
      {
         _throttle = _throttle + 1;
         if(_throttle > 20)
         {
            _throttle = 0;
            sortNow();
         }
      }

      public function sortNow() : void
      {
         var _loc1_:int = this.numChildren;
         var _loc2_:Array = [];
         var _loc3_:DisplayObject = null;
         var _loc4_:Rectangle = null;
         var _loc5_:Number = NaN;
         var _loc6_:Number = NaN;
         var _loc7_:int = 0;
         var _loc8_:int = 0;
         var _loc9_:Array = null;
         if(_loc1_ < 2)
         {
            return;
         }
         while(_loc7_ < _loc1_)
         {
            _loc3_ = this.getChildAt(_loc7_);
            _loc2_[_loc7_] = _loc3_;
            _loc4_ = _loc3_.getBounds(this);
            _loc5_ = _loc4_.bottom;
            _loc6_ = Number(_loc3_.name);
            if(!_loc6_)
            {
               _loc6_ = getNudge();
               _loc3_.name = _loc6_.toString();
            }
            _bottoms[_loc3_] = _loc5_ - _loc6_;
            _loc7_++;
         }
         _loc2_.sort(depthSort);
         _loc7_ = 0;
         while(_loc7_ < _loc1_)
         {
            if(!isRankedDenItem(_loc2_[_loc7_]))
            {
               _loc7_++;
               continue;
            }
            _loc8_ = _loc7_ + 1;
            while(_loc8_ < _loc1_ && isRankedDenItem(_loc2_[_loc8_]))
            {
               _loc8_++;
            }
            _loc9_ = _loc2_.slice(_loc7_,_loc8_);
            _loc9_.sort(denRankSort);
            while(_loc9_.length)
            {
               _loc2_[_loc7_++] = _loc9_.shift();
            }
         }
         _loc7_ = 0;
         while(_loc7_ < _loc1_)
         {
            if(this.getChildAt(_loc7_) != _loc2_[_loc7_])
            {
               this.setChildIndex(_loc2_[_loc7_],_loc7_);
            }
            _loc7_++;
         }
      }

      private function denRankSort(param1:DisplayObject, param2:DisplayObject) : int
      {
         var _loc3_:int = int(_denRanks[param1]) - int(_denRanks[param2]);
         return _loc3_ != 0 ? _loc3_ : depthSort(param1,param2);
      }
      
      private function getNudge() : Number
      {
         _nudge += 0.001;
         if(_nudge > 0.9)
         {
            _nudge = 0;
         }
         return _nudge;
      }
      
      private function sort(param1:Vector.<Number>) : void
      {
         quickSort(param1,0,param1.length - 1);
         InsertionSort(param1,0,param1.length - 1);
      }
      
      private function quickSort(param1:Vector.<Number>, param2:int, param3:int) : void
      {
         var _loc5_:int = 0;
         var _loc6_:int = 0;
         var _loc4_:Number = NaN;
         var _loc7_:int = 4;
         if(param3 - param2 > _loc7_)
         {
            _loc5_ = (param3 + param2) / 2;
            if(param1[param2] > param1[_loc5_])
            {
               swap(param1,param2,_loc5_);
            }
            if(param1[param2] > param1[param3])
            {
               swap(param1,param2,param3);
            }
            if(param1[_loc5_] > param1[param3])
            {
               swap(param1,_loc5_,param3);
            }
            _loc6_ = param3 - 1;
            swap(param1,_loc5_,_loc6_);
            _loc5_ = param2;
            _loc4_ = param1[_loc6_];
            while(true)
            {
               while(param1[++_loc5_] < _loc4_)
               {
               }
               while(param1[--_loc6_] > _loc4_)
               {
               }
               if(_loc6_ < _loc5_)
               {
                  break;
               }
               swap(param1,_loc5_,_loc6_);
            }
            swap(param1,_loc5_,param3 - 1);
            quickSort(param1,param2,_loc6_);
            quickSort(param1,_loc5_ + 1,param3);
         }
      }
      
      private function swap(param1:Vector.<Number>, param2:int, param3:int) : void
      {
         var _loc4_:Number = NaN;
         _loc4_ = param1[param2];
         param1[param2] = param1[param3];
         param1[param3] = _loc4_;
         swapChildrenAt(param2,param3);
      }
      
      private function move(param1:Vector.<Number>, param2:int, param3:int) : void
      {
         param1[param3] = param1[param2];
         addChildAt(getChildAt(param2),param3);
      }
      
      private function InsertionSort(param1:Vector.<Number>, param2:int, param3:int) : void
      {
         var _loc5_:int = 0;
         var _loc6_:int = 0;
         var _loc4_:Number = NaN;
         _loc5_ = param2 + 1;
         while(_loc5_ <= param3)
         {
            _loc4_ = param1[_loc5_];
            _loc6_ = _loc5_;
            while(_loc6_ > param2 && param1[_loc6_ - 1] > _loc4_)
            {
               move(param1,_loc6_ - 1,_loc6_);
               _loc6_--;
            }
            _loc5_++;
         }
      }
   }
}

