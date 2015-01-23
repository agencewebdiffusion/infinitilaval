$(function () {

var Capsule = Backbone.Model.extend({
  defaults: function () {
    return {
      "title" : "Untitled",
      "section" : "Other",
      "duration" : 0,
      "buffer" : 0,
      "seek" : 0,
      "inPlaylist" : false
    };
  },

  toggleInPlaylist: function () {
    this.set({inPlaylist: !this.get("inPlaylist")});
    return this.get("inPlaylist");
  },
  // Send an event to the collection that this capsule should be played
  play : function () {
    this.trigger("play", this);
  }
});

var Playlist = Backbone.Collection.extend({
  model: Capsule,
  initialize: function () {

  },
  selected: function () {
    return this.where({inPlaylist: true});
  },
  toggleSection: function (newSection) {
    // Set all videos in the section to on
    _(this.where({section: newSection})).each(function (capsule) {
      capsule.set({'inPlaylist' : true});
    });
    // Set all videos out of the section to off
    _(this.filter(function (capsule) {
      return capsule.get('section') != newSection;
    })).each(function (capsule) {
      capsule.set({'inPlaylist' : false});
    });
    // Only send one event for views to redraw
    this.trigger("toggleSection");
  },
  getPlaylistRoute : function () {
    // If all active capsules have the same section, use that as the url
    var sections = _(this.selected())
      .chain()
      .map(function (a) {return a.get('section')})
      .uniq()
      .value();

    if (this.selected().length == this.length) {
      // The playlist contains all capsules
      return "";
    } else if (
      // All items in a single section are active
      sections.length == 1 // Only one section has enabled capsules
      && this.where({inPlaylist: true, section: sections[0]}).length == this.where({section: sections[0]}).length // All capsules in the section are enabled
      ) {
      return playlistRouter.getSanitizedSection(sections[0]);
    }
    else { // custom playlist
      return _.reduce(playlist.selected(), function (url, obj) {
        return url + "@" + obj.get('path');
      }, "");
    }
  },
  // Find the next neighbor in the global playlist
  // Build a list of capsules after and before the active capsule
  rotate: function (capsule) {
    var idx = this.indexOf(capsule);
    return _.union(this.rest(idx + 1), this.first(idx));
  },
  next: function(capsule) {
    return _(this.rotate(capsule)).find(function (neighbor) {
      return neighbor.get('inPlaylist');
    });
  },
  previous: function(capsule) {
    return _(this.rotate(capsule).reverse()).find(function (neighbor) {
      return neighbor.get('inPlaylist');
    });
  }
});

// Contains the video player
var VideoView = Backbone.View.extend({
  id: "video-wrapper",
  template: _.template('\
  <video id="media-element" poster="<%= poster %>" controls style="height: 100%; width: 100%"> \
    <% _.each(sources, function (source, type) { %> \
      <source type="<%= type %>" src="<%= source %>"/> \
    <% }); %> \
  </video>'),
  events: {
  },
  initialize: function() {
    // Bind to Analytics objects to send useful events
    this.ga = window.ga;
  },
  render: function () {
    var self = this;
    this.$el.html(this.template(this.model.toJSON()));

    this.player = new MediaElementPlayer("#media-element", {
      iPadUseNativeControls: true,
      iPhoneUseNativeControls: true,
      hideVideoControlsOnLoad: true,
      enablePluginSmoothing: true,
      features: ['playpause', 'progress' ,'volume'],
      success: function (player, node) {
        self.player = player;
        player.addEventListener('ended', function (e) {
          self.ga('send', 'event', 'capsule video', 'complet', self.model.get('title'));
          self.trigger('vimont:ended', e);
        });
        player.addEventListener('canplay', function (e) {
          self.trigger('vimont:canplay', e);
        });
        player.addEventListener('play', function (e) {
          self.ga('send', 'event', 'capsule video', 'play', self.model.get('title'));
          self.trigger('vimont:playing', e);
        });
        self.player = player;
      }
    });

    return this;
  },
  remove: function () {
    this.destroyMEjs();
    this.$el.remove();
    this.stopListening();
    return this;
  },
  destroyMEjs: function () {
    if (mejs) {
      var players = _.keys(mejs.players);
      _.each(players, function(player) {
          mejs.players[player].remove();
      });
    }
  },
  togglePlay: function () {
    this.player.play();
  },
  pause : function () {
    this.player.pause();
  }
});

/**
 * Controls the video player
 */
var PlayerView = Backbone.View.extend({
  id: "player-view",
  className: "app-container",
  template: _.template('<div id="controls"> \
    <a id="controls-back"><i class="fa fa-chevron-left"></i></a> \
    <a id="controls-next"><i class="fa fa-chevron-right"></i></a> \
  </div> \
  <div id="controls-wrapper" class="app-container column"> \
    <div id="screen" class="app-modal"> \
      <div id="timeline"> \
        <div id="timeline-buffer"></div> \
        <div id="timeline-duration"></div> \
        <div id="timeline-title"></div> \
      </div> \
    </div> \
  </div>'),
  events: {
    "click #controls-play" : "togglePlay",
    "click #controls-next" : "nextCapsule",
    "click #controls-back" : "previousCapsule"
  },
  initialize: function () {
    this.$el.html(this.template());
    // Listen to the collection for a video player start
    this.listenTo(this.collection, "play", this.openScreen);
  },
  openScreen: function (activeModel) {

    // The playqueue returned nothing active
    if (activeModel == null) return;
    // Clean up lingering mediaelement player
    if (typeof this.screen !== "undefined") {
      this.stopListening(this.screen);
      this.screen.remove();
    }

    this.screen = new VideoView({model: activeModel});
    this.$('#screen').prepend(this.screen.$el);
    this.screen.render();
    $("#timeline-title").html(activeModel.get('title'));

    // Should these events route through the model instead of the subview?
    this.listenTo(this.screen, "vimont:ended", this.endCapsule);
    this.listenTo(this.screen, "vimont:playing", this.resumed);
  },
  togglePlay: function () {
    this.screen.togglePlay();
  },
  pause : function () {
    this.screen.pause();
  },
  endCapsule: function () {
    this.nextCapsule();

    // Set a timer to start the video
    var size = 0;
    clearInterval(this.startDelay);
    $("#timeline-duration").fadeIn();
    var self = this;
    this.startDelay = setInterval(function () {
      size += 1;
      $("#timeline-duration").width(size + "%");
      if(size >= 100) {
        clearInterval(self.startDelay);
        self.togglePlay();
        $("#timeline-duration").fadeOut();
      }
    }, 5000 / 100);
  },
  resumed: function () {
    clearInterval(this.startDelay);
    $("#timeline-duration").fadeOut();
  },
  nextCapsule: function () {
    // Move active screen in collection, or wrap to start
    this.openScreen(playlist.next(this.screen.model));
  },
  previousCapsule: function () {
    // Move active screen in collection, or wrap to end
    this.openScreen(playlist.previous(this.screen.model));
  }
});

/**
 * A card in a playlist builder view
 */
var PlaylistBuilderItemView = Backbone.View.extend({
  tagName: "li",
  className: "playlist-view grid-item",
  template: _.template('\
  <img class="playlist-capsule-thumbnail" src="<%= poster %>"/> \
  <div class="playlist-capsule-wrapper"> \
    <div class="playlist-capsule-title"> <input class="in-playlist-toggle" type="checkbox" <%= inPlaylist ? "checked=checked" : "" %>/> <%= title %></div> \
  </div>'),
  events: {
    "click" : "toggleInPlaylist"
  },
  render: function () {
    this.$el.html(this.template(this.model.toJSON()));
    return this;
  },
  initialize : function () {
    // Listen to the model to pick up changes in playlist state
    this.listenTo(this.model, "change:inPlaylist", this.render);
  },
  // Add or remove the model from the playlist
  toggleInPlaylist : function (event) {
    this.model.toggleInPlaylist();
  }
});

/**
 * A playlist card to skip to a specific video
 */
var PlaylistItemView = Backbone.View.extend({
  tagName: "li",
  className: "playlist-view grid-item",
  template: _.template('\
  <img class="playlist-capsule-thumbnail" src="<%= poster %>"/> \
  <div class="playlist-capsule-wrapper"> \
    <div class="playlist-capsule-title"> <input class="in-playlist-toggle" type="checkbox" <%= inPlaylist ? "checked=checked" : "" %>/> <%= title %></div> \
  </div>'),
  events: {
    "click" : "loadCapsule"
  },
  render: function () {
    this.$el.html(this.template(this.model.toJSON()));
    return this;
  },
  loadCapsule : function (event) {
    // Send a message to the model to play this capsule
    // Change me to a collection event, player should listen to the collection
    this.model.play();
  }
});

/**
 * Builds a list of cards that can be toggled on or off to indicate if they
 * should be in the playlist
 */
var PlaylistBuilderView = Backbone.View.extend({
  tagName : "ul",
  className : "playlist-builder",
  playlistViews : [],
  initialize : function () {
    // iterate over the collection and add all active models as subviews
    this.fillPlaylist();
  },
  remove : function () {
    _(this.playlistViews).each(function (view) {view.remove()});
    this.$el.remove();
    this.stopListening();
    return this;
  },
  render : function () {
    var self = this;
    _.each(this.playlistViews, function (subview) {
      self.$el.append(subview.render().$el);
    });
    return this;
  },
  fillPlaylist : function () {
    _.each(this.playlistViews, function(subview) {
      subview.remove();
    });
    this.playlistViews = [];
    this.collection.each(this.addPlaylistItem, this);
  },
  addPlaylistItem : function (capsule) {
    var view = new PlaylistBuilderItemView({model: capsule});
    this.playlistViews.push(view);
  }
});

/**
 * Builds a list of cards to skip to a specific capsule
 */
var PlaylistSelectorView = Backbone.View.extend({
  tagName : "ul",
  className : "playlist-selector",
  playlistViews : [],
  initialize : function () {
    // iterate over the collection and add all active models as subviews
    this.fillPlaylist();
    // listen to a change in the collection to rebuild the list
    this.listenTo(this.collection, "change:inPlaylist", this.resetPlaylist);
  },
  remove : function () {
    _(this.playlistViews).each(function (view) {view.remove()});
    this.$el.remove();
    this.stopListening();
    return this;
  },
  render : function () {
    var self = this;
    _.each(this.playlistViews, function (subview) {
      self.$el.append(subview.render().$el);
    });
    return this;
  },
  resetPlaylist : function () {
    // reset the playlist
    _(this.playlistViews).each(function (view) {view.remove()});
    this.playlistViews = [];
    this.fillPlaylist();
    // rerender the element
    this.$el.empty();
    this.render();
  },
  fillPlaylist : function () {
    _.each(this.playlistViews, function(subview) {
      subview.remove();
    });
    this.playlistViews = [];
    _(this.collection.selected()).each(this.addPlaylistItem, this);
  },
  addPlaylistItem : function (capsule) {
    var view = new PlaylistItemView({model: capsule});
    this.playlistViews.push(view);
  }
});

/**
 * Section toggle button
 */
var SectionToggleView = Backbone.View.extend({
  tagName: "a",
  className : "section",
  events : {
    "click": "routeToSection"
  },
  template: _.template('<i class="fa fa-bookmark"></i> <%= section %>'),
  initialize : function (params) {
    this.section = params.section;
  },
  render : function () {
    this.$el.html(this.template({section: this.section}));
    this.delegateEvents();
    return this;
  },
  routeToSection : function () {
    // Update the playlist with right sections
    playlist.toggleSection(this.section);
  }
});

var PlaylistControlsView = Backbone.View.extend({
  initialize : function () {
    this.listenTo(this.collection, 'change:inPlaylist', this.recreateUrl);
    this.sectionToggleViews = [];
    this.fillSections();
  },
  render : function () {
    this.$el.empty();

    var self = this;
    _(this.sectionToggleViews).each(function (view) {
      self.$el.append(view.render().$el);
    });

    // Add an input box to select the url
    $("<input id='playlist-url' readonly/>")
      .bind("click", function () {
        $(this).focus().select();
      })
      .appendTo(this.$el);

    // Add input boxes to edit campaign tracking

    _(['campaignSource','campaignMedium','campaignId']).each(function (field) {
      $("<input id='edit-" + field + "'/><br>")
      .val(window.localStorage.getItem('awd.' + field))
      .attr('placeholder',field)
      .bind('keyup', function (e) {
        window.localStorage.setItem('awd.' + field, $(this).val());
        window.playlistRouter.ga('set', field, $(this).val());
        self.recreateUrl();
      })
      .appendTo(self.$el);
      $("<label for='edit-" + field + "'>" + field + ":</label>").insertBefore(self.$("#edit-" + field ));
    });

    this.recreateUrl();

    return this;
  },
  fillSections : function () {
    var self = this;
    _(this.collection.pluck("section")).chain()
    .uniq()
    .each(function (section) {
      self.sectionToggleViews.push(new SectionToggleView({section: section}))
    });
  },
  recreateUrl : function () {
    // Get the url fragment from the router
    var fragment = this.collection.getPlaylistRoute();

    // Get the query string for analytics campaign tracking
    var queryString = [];

    var campaignSource = window.localStorage.getItem('awd.campaignSource');
    if(campaignSource) {
      queryString.push("utm_source=" + campaignSource);
    }
    var campaignMedium = window.localStorage.getItem('awd.campaignMedium');
    if(campaignMedium) {
      queryString.push("utm_medium=" + campaignMedium);
    }
    var campaignId = window.localStorage.getItem('awd.campaignId');
    if(campaignId) {
      queryString.push("utm_campaign=" + campaignId);
    }
    if(queryString.length > 0) {
      queryString = "?" + queryString.join("&");
    } else {
      queryString = "";
    }

    // Get the document location
    // Reset the url in the input box
    this.$("#playlist-url")
      .val(encodeURI(document.location.origin + document.location.pathname + queryString + '#lecteur/' + fragment ));
  }
});

/**
 * Displays the playlist and playlist administration area
 */
var PlaylistView = Backbone.View.extend({
  id: "scroll-view",
  template: _.template(' \
  <div id="list-view" class=""> \
    <div id="playlist" class=""></div> \
    <div id="toggles"> \
      <a id="advanced-playlist"><i class="fa fa-share-square-o"></i> Partager <i class="fa fa-close"></i></a> \
      <div id="sections"></div> \
    </div> \
  </div> \
  <div id="campaign-view"></div>'),
  events: {
    "click #advanced-playlist" : "advancedPlaylist"
  },
  initialize : function () {
    this.controlsView = new PlaylistControlsView({collection: this.collection});
    // Create a view to list capsules and edit them
    this.activeView = new PlaylistSelectorView({collection: this.collection});
    this.isBuilding = false;
  },
  render : function () {
    this.$el.html(this.template());
    this.$("#playlist").html(this.activeView.render().$el);

    this.$("#sections").empty();
    if(this.isBuilding) {
      this.$("#sections").html(this.controlsView.render().$el);
    }

    return this;
  },
  remove: function () {
    this.activeView.remove();
    this.controlsView.remove();
    this.stopListening();
    this.$el.remove();
    return this;
  },
  advancedPlaylist: function () {
    this.activeView.remove();
    if(this.isBuilding == false) {
      this.activeView = new PlaylistBuilderView({collection: this.collection});
    } else {
      this.activeView = new PlaylistSelectorView({collection: this.collection});
    }
    this.isBuilding = !this.isBuilding;
    this.render();
    this.$el.toggleClass("sharing");
  }
});

/**
 * Builds the global App
 */
var AppView = Backbone.View.extend({
  id: "awd-video-appbox",
  template: _.template(' \
  <div id="menu-icons"> \
    <div id="close-the-app"><i class="fa fa-close"></i></div> \
    <div id="list-shortcut"><i class="fa fa-list"></i></div> \
  </div>'),
  events : {
    "click #close-the-app" : "closeTheApp",
    "click #list-shortcut" : "scrollToThePlaylist"
  },
  initialize : function () {
    // Create a collection of video capsules
    // Using global namespace for now, not sure whether this should be a view
    // object or a specific app object
    this.playlist = window.playlist;
    // Create a player interface
    this.player = new PlayerView({collection: this.collection});
    // Create a playlist interface
    this.playlistView = new PlaylistView({collection: this.collection});

    this.listenTo(this.collection, "play", this.scrollToThePlayer);
  },
  render : function () {
    this.$el.html(this.template());
    this.$el.append(this.player.$el);
    this.$el.append(this.playlistView.render().$el);
    return this;
  },
  remove : function () {
    this.player.remove();
    this.playlistView.remove();

    this.$el.remove();
    this.stopListening();
    return this;
  },
  closeTheApp : function () {
    // Return the user to the page if this is a lightbox app
    this.$el.removeClass("overlay");
    this.player.pause();
    playlistRouter.navigate();
  },
  openTheApp : function () {
    // Bring the view to the front
    this.$el.addClass("overlay");
  },
  scrollToThePlayer : function () {
    this.$el.animate({"scrollTop" : 0});
  },
  scrollToThePlaylist : function () {
    // Scrolls the app up and down between the player and playlist views
    this.$el.animate({"scrollTop" : this.player.$el.height()});
  }
});

var PlaylistRouter = Backbone.Router.extend({
  routes: {
    "lecteur(/)(:liste)" : "startPlaylist"
  },
  initialize: function () {
    this.initializeSectionsHash();

    // Bind to Google Analytics
    this.ga = window.ga;

    // Get campaign details from local storage if available
    var campaignSource = localStorage.getItem("awd.campaignSource");
    if(campaignSource !== null) {
      this.ga('set','campaignSource', campaignSource);
    }
    var campaignMedium = localStorage.getItem("awd.campaignMedium");
    if(campaignMedium !== null) {
      this.ga('set','campaignMedium', campaignMedium);
    }
    var campaignId = localStorage.getItem("awd.campaignId");
    if(campaignId !== null) {
      this.ga('set','campaignId', campaignId);
    }
  },
  //Make some nice routes out of playlist sections
  initializeSectionsHash : function () {
    var rawSections = _(playlist.pluck("section")).uniq();
    this.sectionsHash = _(rawSections).chain()
    .map(function (section) {
      var sectionPath = section.replace(/\s+/g, '-').toLowerCase();
      return sectionPath;
    }).value();
    this.sectionsHash = _.object(rawSections, this.sectionsHash);
  },
  getSanitizedSection: function (section) {
    return this.sectionsHash[section];
  },
  navigateToSection: function (section) {
    this.navigate(this.sectionsHash[section], {trigger: false, replace: true});
  },
  // Main route for the modal application
  // Will bring up the application, build a playlist out of capsules selected in
  // the url, and start the playlist
  startPlaylist : function (list) {
    this.ga("send","pageview", Backbone.history.root + Backbone.history.getFragment());

    if(list) {
      // If requesting a section, load all its capsules
      if(_.contains(this.sectionsHash, list)) {
        playlist.toggleSection(_(this.sectionsHash).invert()[list]);
      } else {
        // Otherwise load individual capsules
        var inQueue = list.split(/@/);

        playlist.each(function (capsule) {
          if(_(inQueue).contains(capsule.get('path'))) {
            capsule.set({"inPlaylist": true});
          } else {
            capsule.set({"inPlaylist": false});
          }
        });
      }
    } else {
      // Load every capsule
      playlist.each(function (capsule) {
        capsule.set({'inPlaylist': true});
      });
    }
    var startingCapsule = playlist.where({"inPlaylist": true}).shift();
    if (startingCapsule) startingCapsule.play();

    appView.openTheApp();
  }
});


// Must load this from the included JSON data
  window.playlist = new Playlist(playlistData);
  var appView = new AppView({collection: playlist});
  $("body").append(appView.render().el);
  window.playlistRouter = new PlaylistRouter();
  Backbone.history.start();
});
