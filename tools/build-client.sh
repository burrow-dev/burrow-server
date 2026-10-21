#!/bin/sh
# rebuilds swf/ajclient.swf: the untouched client (swf/ajclient.before-finder.swf)
# with every class in swf-src/ compiled over its original, by JPEXS (tools/ffdec,
# needs Java). the result is the same bytes every time.
#
#   tools/build-client.sh [output.swf]      (default: swf/ajclient.swf)
#
# A class added to swf-src/ needs a line below: its full name, then its file.
#
# one thing is not a whole class: gui.EmoticonUtility's static initialiser,
# as P-code, with our emote added to its lists (tools/make-emote.py). the
# decompiler gets two of that class's functions wrong, so the class cannot
# be compiled from its source. 4839 is that method body's place in the
# untouched client.
#
# gui.BulletinBoard cannot be compiled from its source either (its media
# callback comes out as loops that do not do what the bytecode does), so two
# of its methods are replaced as P-code: the tutorial and "what's new" video
# lists return at once when empty, as this server sends them (they threw).
# 3830 and 3832 are those method bodies' places in the untouched client.
set -e
cd "$(dirname "$(readlink -f "$0")")/.."
out=${1:-swf/ajclient.swf}
set -- \
  AJClient AJClient.as \
  GlobalErrorCatch GlobalErrorCatch.as \
  XtReplyDemuxer XtReplyDemuxer.as \
  loader.MediaHelper MediaHelper.as \
  com.sbi.graphics.PaletteHelper PaletteHelper.as \
  gui.ColorTable ColorTable.as \
  gui.MySettings MySettings.as \
  gui.itemWindows.ItemWindowToggle ItemWindowToggle.as \
  gui.ReportAPlayer ReportAPlayer.as \
  gui.ECardCreation ECardCreation.as \
  gui.GuiManager GuiManager.as \
  gui.ActionManager ActionManager.as \
  gui.PlayerSearch PlayerSearch.as \
  avatar.NPCView NPCView.as \
  gui.ChatHistory ChatHistory.as \
  gui.PredictiveTextManager PredictiveTextManager.as \
  avatar.UserCommXtCommManager UserCommXtCommManager.as \
  buddy.BuddyCard BuddyCard.as \
  gui.itemWindows.ItemWindowPets ItemWindowPets.as \
  gui.itemWindows.ItemWindowAvtPetSml ItemWindowAvtPetSml.as \
  gui.itemWindows.ItemWindowBuddyList ItemWindowBuddyList.as \
  shop.Shop Shop.as \
  shop.ShopManager ShopManager.as \
  avatar.Avatar Avatar.as \
  gui.ChatBalloon ChatBalloon.as \
  room.RoomManagerView RoomManagerView.as \
  gui.itemWindows.ItemWindowOriginal ItemWindowOriginal.as \
  gui.itemWindows.ItemWindowAnimal ItemWindowAnimal.as \
  gui.DenAndClothesItemSelect DenAndClothesItemSelect.as \
  gui.RecycleItems RecycleItems.as \
  gui.AvatarEditor AvatarEditor.as \
  gui.PetInventory PetInventory.as \
  gui.DenEditor DenEditor.as \
  gui.TradeManager TradeManager.as \
  avatar.AvatarWorldView AvatarWorldView.as \
  room.RoomManagerWorld RoomManagerWorld.as \
  gskinner.motion.GTween GTween.as \
  playerWall.PostMessage PostMessage.as \
  shop.BundleShop BundleShop.as \
  gui.GenericListGuiManager GenericListGuiManager.as \
  gui.DenSwitcher DenSwitcher.as \
  gui.PetCreator PetCreator.as \
  gui.NGFactManager NGFactManager.as \
  game.distanceChallenge.DistanceChallenge DistanceChallenge.as \
  buddy.BuddyList BuddyList.as \
  Party.PartyPopup PartyPopup.as \
  gui.ECardInbox ECardInbox.as \
  game.SoundManager SoundManager.as \
  com.sbi.graphics.LayerAnim LayerAnim.as \
  com.sbi.graphics.LayerBitmap LayerBitmap.as \
  com.sbi.graphics.SortLayer SortLayer.as \
  room.DenItemHolder DenItemHolder.as \
  ecard.ECard ECard.as \
  game.ArtStudioKit ArtStudioKit.as \
  game.artStudioPainting.ArtStudioPainting ArtStudioPainting.as \
  game.artStudioGridDrawing.ArtStudioGridDrawing ArtStudioGridDrawing.as
# not in the game: added before the replace (game.ArtStudioKit is Strawberry
# Jam's, shared by its two art studio painters)
NEW_CLASSES="game.ArtStudioKit"
args=""
while [ $# -gt 0 ]; do
  args="$args $1 swf-src/$2"
  shift 2
done
# classes the game never had (NEW_CLASSES) are added empty first
# (tools/AddClass.java), for the replace to fill in from swf-src/
base=$(mktemp --suffix=.swf)
trap 'rm -f "$base"' EXIT
java -cp "tools/ffdec/lib/*" tools/AddClass.java swf/ajclient.before-finder.swf "$base" $NEW_CLASSES
# shellcheck disable=SC2086
java -jar tools/ffdec/ffdec-cli.jar -replace "$base" "$out" \
  gui.EmoticonUtility swf-src/EmoticonUtility.cinit.pcode 4839 \
  gui.BulletinBoard swf-src/BulletinBoard.onTutorialGLReceived.pcode 3830 \
  gui.BulletinBoard swf-src/BulletinBoard.onWhatsNewVideosLoaded.pcode 3832 $args | grep -v "^Replac\|EXPERIMENTAL" || true
ls -l "$out"
