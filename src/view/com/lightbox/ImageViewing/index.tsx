/**
 * Copyright (c) JOB TODAY S.A. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// Original code copied and simplified from the link below as the codebase is currently not maintained:
// https://github.com/jobtoday/react-native-image-viewing

import React, {useCallback, useState} from 'react'
import {
  LayoutAnimation,
  PixelRatio,
  Platform,
  StyleSheet,
  View,
} from 'react-native'
import {Gesture} from 'react-native-gesture-handler'
import PagerView from 'react-native-pager-view'
import Animated, {
  AnimatedRef,
  cancelAnimation,
  interpolate,
  LinearTransition,
  measure,
  runOnJS,
  SharedValue,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDecay,
  withSpring,
} from 'react-native-reanimated'
import {
  Edge,
  SafeAreaView,
  useSafeAreaFrame,
  useSafeAreaInsets,
} from 'react-native-safe-area-context'
import {FontAwesomeIcon} from '@fortawesome/react-native-fontawesome'
import {Trans} from '@lingui/macro'

import {useImageDimensions} from '#/lib/media/image-sizes'
import {colors, s} from '#/lib/styles'
import {isAndroid, isIOS} from '#/platform/detection'
import {Lightbox} from '#/state/lightbox'
import {Button} from '#/view/com/util/forms/Button'
import {Text} from '#/view/com/util/text/Text'
import {ScrollView} from '#/view/com/util/Views'
import {PlatformInfo} from '../../../../../modules/expo-bluesky-swiss-army'
import {ImageSource} from './@types'
import ImageDefaultHeader from './components/ImageDefaultHeader'
import ImageItem from './components/ImageItem/ImageItem'

type Rect = {x: number; y: number; width: number; height: number}

const PIXEL_RATIO = PixelRatio.get()
const EDGES =
  Platform.OS === 'android'
    ? (['top', 'bottom', 'left', 'right'] satisfies Edge[])
    : (['left', 'right'] satisfies Edge[]) // iOS, so no top/bottom safe area

const SLOW_SPRING = {stiffness: 120}
const FAST_SPRING = {stiffness: 700}
const SLOW_SPRING_AS_TRANSITION = LinearTransition.springify()
  .overshootClamping(true as any /* Typings are wrong */)
  .stiffness(SLOW_SPRING.stiffness)

export default function ImageViewRoot({
  lightbox: nextLightbox,
  onRequestClose,
  onPressSave,
  onPressShare,
}: {
  lightbox: Lightbox | null
  onRequestClose: () => void
  onPressSave: (uri: string) => void
  onPressShare: (uri: string) => void
}) {
  'use no memo'
  const ref = useAnimatedRef<View>()
  const [activeLightbox, setActiveLightbox] = useState(nextLightbox)
  const openProgress = useSharedValue(0)
  const openProgressTo = useSharedValue(0)

  if (!activeLightbox && nextLightbox) {
    setActiveLightbox(nextLightbox)
  }

  const updateOpenProgress = React.useCallback(
    (toValue: number, animate: boolean) => {
      'worklet'
      // These *must* always be updated together.
      openProgressTo.value = toValue
      openProgress.value = animate
        ? withClampedSpring(toValue, SLOW_SPRING)
        : toValue
    },
    [openProgress, openProgressTo],
  )

  React.useEffect(() => {
    if (!nextLightbox) {
      return
    }

    const canAnimate =
      !PlatformInfo.getIsReducedMotionEnabled() &&
      nextLightbox.images.every(img => img.dimensions && img.thumbRect)

    updateOpenProgress(1, canAnimate)
    return () => {
      updateOpenProgress(0, canAnimate)
    }
  }, [nextLightbox, updateOpenProgress])

  useAnimatedReaction(
    () => openProgress.value === 0,
    (isGone, wasGone) => {
      if (isGone && !wasGone) {
        runOnJS(setActiveLightbox)(null)
      }
    },
  )

  const onFlyAway = React.useCallback(() => {
    'worklet'
    updateOpenProgress(0, false)
    runOnJS(onRequestClose)()
  }, [onRequestClose, updateOpenProgress])

  return (
    // Keep it always mounted to avoid flicker on the first frame.
    <SafeAreaView
      style={[styles.screen, !activeLightbox && styles.screenHidden]}
      edges={EDGES}
      aria-modal
      accessibilityViewIsModal
      aria-hidden={!activeLightbox}>
      <Animated.View ref={ref} style={{flex: 1}} collapsable={false}>
        {activeLightbox && (
          <ImageView
            key={activeLightbox.id}
            lightbox={activeLightbox}
            onRequestClose={onRequestClose}
            onPressSave={onPressSave}
            onPressShare={onPressShare}
            onFlyAway={onFlyAway}
            safeAreaRef={ref}
            openProgress={openProgress}
            openProgressTo={openProgressTo}
          />
        )}
      </Animated.View>
    </SafeAreaView>
  )
}

function ImageView({
  lightbox,
  onRequestClose,
  onPressSave,
  onPressShare,
  onFlyAway,
  safeAreaRef,
  openProgress,
  openProgressTo,
}: {
  lightbox: Lightbox
  onRequestClose: () => void
  onPressSave: (uri: string) => void
  onPressShare: (uri: string) => void
  onFlyAway: () => void
  safeAreaRef: AnimatedRef<View>
  openProgress: SharedValue<number>
  openProgressTo: SharedValue<number>
}) {
  const {images, index: initialImageIndex} = lightbox
  const [isScaled, setIsScaled] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [imageIndex, setImageIndex] = useState(initialImageIndex)
  const [showControls, setShowControls] = useState(true)
  const [isAltExpanded, setAltExpanded] = React.useState(false)
  const dismissSwipeTranslateY = useSharedValue(0)
  const isFlyingAway = useSharedValue(false)

  const containerStyle = useAnimatedStyle(() => {
    if (openProgress.value < 1 || isFlyingAway.value) {
      return {pointerEvents: 'none'}
    }
    return {pointerEvents: 'auto'}
  })
  const backdropStyle = useAnimatedStyle(() => {
    const screenSize = measure(safeAreaRef)
    let opacity = 1
    if (openProgress.value < 1) {
      opacity = Math.sqrt(openProgress.value)
    } else if (screenSize) {
      const dragProgress = Math.min(
        Math.abs(dismissSwipeTranslateY.value) / (screenSize.height / 2),
        1,
      )
      opacity -= dragProgress
    }
    return {
      opacity,
    }
  })
  const animatedHeaderStyle = useAnimatedStyle(() => {
    const show = showControls && dismissSwipeTranslateY.value === 0
    return {
      pointerEvents: show ? 'box-none' : 'none',
      opacity: withClampedSpring(
        show && openProgress.value === 1 ? 1 : 0,
        FAST_SPRING,
      ),
      transform: [
        {
          translateY: withClampedSpring(show ? 0 : -30, FAST_SPRING),
        },
      ],
    }
  })
  const animatedFooterStyle = useAnimatedStyle(() => {
    const show = showControls && dismissSwipeTranslateY.value === 0
    return {
      flexGrow: 1,
      pointerEvents: show ? 'box-none' : 'none',
      opacity: withClampedSpring(
        show && openProgress.value === 1 ? 1 : 0,
        FAST_SPRING,
      ),
      transform: [
        {
          translateY: withClampedSpring(show ? 0 : 30, FAST_SPRING),
        },
      ],
    }
  })

  const onTap = useCallback(() => {
    setShowControls(show => !show)
  }, [])

  const onZoom = useCallback((nextIsScaled: boolean) => {
    setIsScaled(nextIsScaled)
    if (nextIsScaled) {
      setShowControls(false)
    }
  }, [])

  return (
    <Animated.View style={[styles.container, containerStyle]}>
      <Animated.View
        style={[styles.backdrop, backdropStyle]}
        renderToHardwareTextureAndroid
      />
      <PagerView
        scrollEnabled={!isScaled}
        initialPage={initialImageIndex}
        onPageSelected={e => {
          setImageIndex(e.nativeEvent.position)
          setIsScaled(false)
        }}
        onPageScrollStateChanged={e => {
          setIsDragging(e.nativeEvent.pageScrollState !== 'idle')
        }}
        overdrag={true}
        style={styles.pager}>
        {images.map((imageSrc, i) => (
          <View key={imageSrc.uri}>
            <LightboxImage
              onTap={onTap}
              onZoom={onZoom}
              imageSrc={imageSrc}
              onRequestClose={onRequestClose}
              onFlyAway={onFlyAway}
              isScrollViewBeingDragged={isDragging}
              showControls={showControls}
              safeAreaRef={safeAreaRef}
              isScaled={isScaled}
              isFlyingAway={isFlyingAway}
              isActive={i === imageIndex}
              dismissSwipeTranslateY={dismissSwipeTranslateY}
              openProgress={openProgress}
              openProgressTo={openProgressTo}
            />
          </View>
        ))}
      </PagerView>
      <View style={styles.controls}>
        <Animated.View
          style={animatedHeaderStyle}
          renderToHardwareTextureAndroid>
          <ImageDefaultHeader onRequestClose={onRequestClose} />
        </Animated.View>
        <Animated.View
          style={animatedFooterStyle}
          renderToHardwareTextureAndroid={!isAltExpanded}>
          <LightboxFooter
            images={images}
            index={imageIndex}
            isAltExpanded={isAltExpanded}
            toggleAltExpanded={() => setAltExpanded(e => !e)}
            onPressSave={onPressSave}
            onPressShare={onPressShare}
          />
        </Animated.View>
      </View>
    </Animated.View>
  )
}

function LightboxImage({
  imageSrc,
  onTap,
  onZoom,
  onRequestClose,
  onFlyAway,
  isScrollViewBeingDragged,
  isScaled,
  isFlyingAway,
  isActive,
  showControls,
  safeAreaRef,
  openProgress,
  openProgressTo,
  dismissSwipeTranslateY,
}: {
  imageSrc: ImageSource
  onRequestClose: () => void
  onTap: () => void
  onZoom: (scaled: boolean) => void
  onFlyAway: () => void
  isScrollViewBeingDragged: boolean
  isScaled: boolean
  isActive: boolean
  isFlyingAway: SharedValue<boolean>
  showControls: boolean
  safeAreaRef: AnimatedRef<View>
  openProgress: SharedValue<number>
  openProgressTo: SharedValue<number>
  dismissSwipeTranslateY: SharedValue<number>
}) {
  const [imageAspect, imageDimensions] = useImageDimensions({
    src: imageSrc.uri,
    knownDimensions: imageSrc.dimensions,
  })

  const safeFrameDelayedForJSThreadOnly = useSafeAreaFrame()
  const safeInsetsDelayedForJSThreadOnly = useSafeAreaInsets()
  const measureSafeArea = React.useCallback(() => {
    'worklet'
    let safeArea: Rect | null = measure(safeAreaRef)
    if (!safeArea) {
      if (_WORKLET) {
        console.error('Expected to always be able to measure safe area.')
      }
      const frame = safeFrameDelayedForJSThreadOnly
      const insets = safeInsetsDelayedForJSThreadOnly
      safeArea = {
        x: frame.x + insets.left,
        y: frame.y + insets.top,
        width: frame.width - insets.left - insets.right,
        height: frame.height - insets.top - insets.bottom,
      }
    }
    return safeArea
  }, [
    safeFrameDelayedForJSThreadOnly,
    safeInsetsDelayedForJSThreadOnly,
    safeAreaRef,
  ])

  const {thumbRect, dimensions} = imageSrc
  const interpolation = useDerivedValue(() => {
    'worklet'
    const safeArea = measureSafeArea()
    const finalWidth = safeArea.width
    const finalHeight = imageAspect ? safeArea.width / imageAspect : undefined
    const dismissTranslateY =
      isActive && openProgress.value === 1 ? dismissSwipeTranslateY.value : 0
    if (isActive && thumbRect && dimensions) {
      return interpolateTransform(
        openProgress.value,
        openProgressTo.value,
        thumbRect,
        safeArea,
        dimensions,
        dismissTranslateY,
      )
    }
    return {
      transform: [{translateY: dismissTranslateY}],
      width: finalWidth,
      height: finalHeight,
    }
  })

  const containerStyle = useAnimatedStyle(() => {
    const {transform} = interpolation.value
    return {
      flex: 1,
      transform,
    }
  })

  const type = imageSrc.type
  const borderRadius =
    type === 'circle-avi' ? 1e5 : type === 'rect-avi' ? 20 : 0
  const imageStyle = useAnimatedStyle(() => {
    const {width, height} = interpolation.value
    return {
      borderRadius,
      width,
      height,
    }
  })

  const dismissSwipePan = Gesture.Pan()
    .enabled(isActive && !isScaled)
    .activeOffsetY([-10, 10])
    .failOffsetX([-10, 10])
    .maxPointers(1)
    .onUpdate(e => {
      'worklet'
      if (openProgress.value !== 1) {
        return
      }
      dismissSwipeTranslateY.value = e.translationY
    })
    .onEnd(e => {
      'worklet'
      if (openProgress.value !== 1) {
        return
      }
      if (Math.abs(e.velocityY) > 1000) {
        isFlyingAway.value = true
        dismissSwipeTranslateY.value = withDecay({
          velocity: e.velocityY,
          velocityFactor: Math.max(3000 / Math.abs(e.velocityY), 1), // Speed up if it's too slow.
          deceleration: 1, // Danger! This relies on the reaction below stopping it.
        })
      } else {
        dismissSwipeTranslateY.value = withSpring(0, {
          stiffness: 700,
          damping: 50,
        })
      }
    })
  useAnimatedReaction(
    () => {
      const screenSize = measure(safeAreaRef)
      return (
        !screenSize ||
        Math.abs(dismissSwipeTranslateY.value) > screenSize.height
      )
    },
    (isOut, wasOut) => {
      if (isOut && !wasOut) {
        // Stop the animation from blocking the screen forever.
        cancelAnimation(dismissSwipeTranslateY)
        onFlyAway()
      }
    },
  )

  return (
    <Animated.View style={containerStyle}>
      <ImageItem
        imageSrc={imageSrc}
        onTap={onTap}
        onZoom={onZoom}
        onRequestClose={onRequestClose}
        isScrollViewBeingDragged={isScrollViewBeingDragged}
        showControls={showControls}
        measureSafeArea={measureSafeArea}
        imageAspect={imageAspect}
        imageDimensions={imageDimensions}
        imageStyle={imageStyle}
        dismissSwipePan={dismissSwipePan}
        layoutAnimationAndroid={SLOW_SPRING_AS_TRANSITION}
      />
    </Animated.View>
  )
}

function LightboxFooter({
  images,
  index,
  isAltExpanded,
  toggleAltExpanded,
  onPressSave,
  onPressShare,
}: {
  images: ImageSource[]
  index: number
  isAltExpanded: boolean
  toggleAltExpanded: () => void
  onPressSave: (uri: string) => void
  onPressShare: (uri: string) => void
}) {
  const {alt: altText, uri} = images[index]
  const isMomentumScrolling = React.useRef(false)
  return (
    <ScrollView
      style={styles.footerScrollView}
      scrollEnabled={isAltExpanded}
      onMomentumScrollBegin={() => {
        isMomentumScrolling.current = true
      }}
      onMomentumScrollEnd={() => {
        isMomentumScrolling.current = false
      }}
      contentContainerStyle={{
        paddingVertical: 12,
        paddingHorizontal: 24,
      }}>
      <SafeAreaView edges={['bottom']}>
        {altText ? (
          <View accessibilityRole="button" style={styles.footerText}>
            <Text
              style={[s.gray3]}
              numberOfLines={isAltExpanded ? undefined : 3}
              selectable
              onPress={() => {
                if (isMomentumScrolling.current) {
                  return
                }
                LayoutAnimation.configureNext({
                  duration: 450,
                  update: {type: 'spring', springDamping: 1},
                })
                toggleAltExpanded()
              }}
              onLongPress={() => {}}>
              {altText}
            </Text>
          </View>
        ) : null}
        <View style={styles.footerBtns}>
          <Button
            type="primary-outline"
            style={styles.footerBtn}
            onPress={() => onPressSave(uri)}>
            <FontAwesomeIcon icon={['far', 'floppy-disk']} style={s.white} />
            <Text type="xl" style={s.white}>
              <Trans context="action">Save</Trans>
            </Text>
          </Button>
          <Button
            type="primary-outline"
            style={styles.footerBtn}
            onPress={() => onPressShare(uri)}>
            <FontAwesomeIcon icon="arrow-up-from-bracket" style={s.white} />
            <Text type="xl" style={s.white}>
              <Trans context="action">Share</Trans>
            </Text>
          </Button>
        </View>
      </SafeAreaView>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
  },
  screenHidden: {
    opacity: 0,
    pointerEvents: 'none',
  },
  container: {
    flex: 1,
  },
  backdrop: {
    backgroundColor: '#000',
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  controls: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    gap: 20,
    zIndex: 1,
    pointerEvents: 'box-none',
  },
  pager: {
    flex: 1,
  },
  header: {
    position: 'absolute',
    width: '100%',
    top: 0,
    pointerEvents: 'box-none',
  },
  footer: {
    position: 'absolute',
    width: '100%',
    maxHeight: '100%',
    bottom: 0,
  },
  footerScrollView: {
    backgroundColor: '#000d',
    flex: 1,
    position: 'absolute',
    bottom: 0,
    width: '100%',
    maxHeight: '100%',
  },
  footerText: {
    paddingBottom: isIOS ? 20 : 16,
  },
  footerBtns: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  footerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'transparent',
    borderColor: colors.white,
  },
})

function interpolatePx(
  px: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
) {
  'worklet'
  const value = interpolate(px, inputRange, outputRange)
  return Math.round(value * PIXEL_RATIO) / PIXEL_RATIO
}

function interpolateTransform(
  progress: number,
  progressTo: number,
  thumbnailDims: {
    pageX: number
    width: number
    pageY: number
    height: number
  },
  safeArea: {width: number; height: number; x: number; y: number},
  imageDims: {width: number; height: number},
  dismissTranslateY: number,
) {
  'worklet'
  const imageAspect = imageDims.width / imageDims.height
  const thumbAspect = thumbnailDims.width / thumbnailDims.height
  let uncroppedInitialWidth
  let uncroppedInitialHeight
  if (imageAspect > thumbAspect) {
    uncroppedInitialWidth = thumbnailDims.height * imageAspect
    uncroppedInitialHeight = thumbnailDims.height
  } else {
    uncroppedInitialWidth = thumbnailDims.width
    uncroppedInitialHeight = thumbnailDims.width / imageAspect
  }
  const finalWidth = safeArea.width
  const finalHeight = safeArea.width / imageAspect
  const initialScale = Math.min(
    uncroppedInitialWidth / finalWidth,
    uncroppedInitialHeight / finalHeight,
  )
  const croppedFinalWidth = thumbnailDims.width / initialScale
  const croppedFinalHeight = thumbnailDims.height / initialScale
  const screenCenterX = safeArea.width / 2
  const screenCenterY = safeArea.height / 2
  const thumbnailSafeAreaX = thumbnailDims.pageX - safeArea.x
  const thumbnailSafeAreaY = thumbnailDims.pageY - safeArea.y
  const thumbnailCenterX = thumbnailSafeAreaX + thumbnailDims.width / 2
  const thumbnailCenterY = thumbnailSafeAreaY + thumbnailDims.height / 2
  const initialTranslateX = thumbnailCenterX - screenCenterX
  const initialTranslateY = thumbnailCenterY - screenCenterY
  const scale = interpolate(progress, [0, 1], [initialScale, 1])
  const translateX = interpolatePx(progress, [0, 1], [initialTranslateX, 0])
  const translateY = interpolatePx(progress, [0, 1], [initialTranslateY, 0])
  const cropTranslateX = interpolatePx(
    progress,
    [0, 1],
    [(finalWidth - croppedFinalWidth) / 2, 0],
  )
  let width
  let height
  if (isAndroid) {
    // On Android, interpolating `progress` here is too slow and choppy.
    // Instead, we'll use discrete `progressTo` and rely on `layout` animation.
    width = progressTo === 0 ? croppedFinalWidth : finalWidth
    height = progressTo === 0 ? croppedFinalHeight : finalHeight
  } else {
    // On iOS, interpolating these directly works fine.
    // In fact, using the above approach would lead to incorrect positions.
    width = interpolatePx(progress, [0, 1], [croppedFinalWidth, finalWidth])
    height = interpolatePx(progress, [0, 1], [croppedFinalHeight, finalHeight])
  }
  return {
    transform: [
      {translateY: dismissTranslateY},
      {translateX},
      {translateY},
      {scale},
      {translateX: cropTranslateX},
    ],
    width,
    height,
  }
}

function withClampedSpring(value: any, {stiffness}: {stiffness: number}) {
  'worklet'
  return withSpring(value, {overshootClamping: true, stiffness})
}
