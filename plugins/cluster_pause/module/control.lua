local ClusterPause = require("modules/cluster_pause/cluster-pause")

local ClusterPauseModule = {}

function ClusterPauseModule.add_remote_interface()
	remote.add_interface("cluster_pause", {
		set_paused = ClusterPause.set_paused,
	})
end

return ClusterPauseModule
